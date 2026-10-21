/**
 * LLM-free owner controls: configured-channel commands and Telegram approval buttons.
 *
 * Flow for every mutation:
 *   guard (configured channel, private chat, senderId == configured owner id,
 *   host-authorized, not an internal Gateway caller)
 *   → parse a fixed grammar (no free text reaches the broker as authority)
 *   → sign an OwnerIngressProof with the ingress key
 *   → owner_intent over the authenticated ingress socket
 *   → the broker re-verifies MAC, sender, chat, freshness and single use.
 *
 * Approvals additionally require a code bound to the exact binding hash the
 * owner was shown (button callback data or `/papprove <id> <code>`).
 */
import { randomUUID } from 'node:crypto';
import type { PluginConfig, SecretsProvider } from './config.ts';
import { checkOwnerCallback, checkOwnerCommand, createReplayCache, type CallbackContextLike, type CommandContextLike, type ReplayCache } from './guard.ts';
import { signOwnerControl, signOwnerIngress, type OwnerIntent } from './ingress.ts';
import { ACTION_ID_PATTERN, APPROVAL_ID_PATTERN, approvalCode, callbackData, parseCallbackPayload, verifyApprovalCode } from './nonce.ts';
import { renderActionLine, renderControls, renderPendingLine, renderPreview, untrusted, type ActionStatusView, type ApprovalPreview, type ControlSnapshot } from './render.ts';
import { rpcCall, rpcCalls, type RpcResult } from './rpc.ts';

export interface PresentationButton {
  label: string;
  action: { type: 'callback'; value: string };
  style?: 'primary' | 'secondary' | 'success' | 'danger';
}
export interface Presentation {
  title?: string;
  blocks: ({ type: 'text'; text: string } | { type: 'buttons'; buttons: PresentationButton[] })[];
}
export interface OwnerReply {
  text: string;
  presentation?: Presentation;
}

export const NOT_AVAILABLE = 'This command is not available here.';
const INTEGRATION_RE = /^[a-z0-9_-]{1,32}$/;
const ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MEMORY_ID_RE = /^[A-Za-z0-9_:.-]{1,80}$/;

export const OWNER_SUBCOMMANDS = ['status', 'pause', 'resume', 'approvals', 'approve', 'deny', 'cancel', 'revoke', 'reinstate', 'forget', 'remember', 'testcall', 'help'] as const;
export type OwnerSubcommand = (typeof OWNER_SUBCOMMANDS)[number];

/**
 * Registered command names → subcommand. `/status` is reserved by OpenClaw
 * core and `/approve` is the core exec-approval command, so those two use a
 * `p` prefix. Everything is also reachable as `/potts <subcommand>`.
 */
export const COMMAND_ALIASES: Record<string, OwnerSubcommand | 'root'> = {
  potts: 'root',
  pstatus: 'status',
  pause: 'pause',
  resume: 'resume',
  approvals: 'approvals',
  papprove: 'approve',
  deny: 'deny',
  cancel: 'cancel',
  revoke: 'revoke',
  forget: 'forget',
};

export interface OwnerDeps {
  cfg: PluginConfig;
  secrets: SecretsProvider;
  now?: () => Date;
  newRef?: () => string;
  replay?: ReplayCache;
  log?: (event: string, data: Record<string, unknown>) => void;
  timeoutMs?: number;
}

const HELP = [
  'Potts owner controls:',
  '/pstatus — controls, pending approvals, recent actions',
  '/pause [integration] — pause everything or one integration',
  '/resume [integration] — resume everything or one integration',
  '/approvals — list pending approvals',
  '/papprove <approval-id> — review an approval (buttons or code to confirm)',
  '/deny <approval-id> [reason]',
  '/cancel <approval-id|action-id>',
  '/revoke <account-id> [reason] · /potts reinstate <account-id>',
  '/forget <memory-id>',
  '/potts remember <fact or preference> — save your exact words locally',
  '/potts testcall — place one test owner-alert call (only if calls are enabled; never during quiet hours)',
].join('\n');

function tokens(s: string | undefined): string[] {
  return (s ?? '').trim().split(/\s+/).filter(Boolean);
}

export function createOwnerHandlers(deps: OwnerDeps) {
  const now = deps.now ?? (() => new Date());
  const newRef = deps.newRef ?? (() => randomUUID());
  const replay = deps.replay ?? createReplayCache();
  const log = deps.log ?? (() => {});
  const timeoutMs = deps.timeoutMs ?? 10_000;

  const ingress = async <T>(key: Buffer, method: string, params: Record<string, unknown> = {}): Promise<RpcResult<T>> =>
    rpcCall<T>(deps.cfg.ingressSocket, method, params, { ingressKey: key, timeoutMs });

  const sendIntent = async (key: Buffer, ownerId: string, updateId: string, intent: OwnerIntent): Promise<RpcResult<{ type: string; [k: string]: unknown }>> => {
    const proof = signOwnerIngress(key, { source: deps.cfg.deliveryChannel ?? 'telegram', senderId: ownerId, chatId: ownerId, chatType: 'private', updateId, receivedAt: now().toISOString(), intent });
    return ingress(key, 'owner_intent', { proof });
  };

  const brokerError = (r: { ok: false; error: { code: string; message: string } }) => {
    if (r.error.code === 'unavailable') return 'Potts is not running right now, so nothing changed.';
    return `Not done: ${untrusted(r.error.message)}`;
  };

  const describeOutcome = (o: { type: string; [k: string]: unknown }): string => {
    switch (o.type) {
      case 'approved':
        return 'Approved. Doing it now (once).';
      case 'approval_closed': {
        const a = o.approval as { id: string; status: string };
        return a.status === 'denied' ? 'Denied. Nothing will be sent.' : a.status === 'cancelled' ? 'Cancelled.' : `That request is now ${a.status}.`;
      }
      case 'action_cancelled':
        return 'Cancelled.';
      case 'controls':
        return renderControls(o.controls as ControlSnapshot);
      case 'test_call':
        return untrusted(String(o.message ?? 'Test call queued.'));
      default:
        return 'Done.';
    }
  };

  const reviewReply = (key: Buffer, p: ApprovalPreview): OwnerReply => {
    const r = renderPreview(p);
    if (!r.complete || p.status !== 'pending') {
      return { text: p.status !== 'pending' ? `Approval ${p.approvalId} is ${p.status}; nothing to approve.` : r.text };
    }
    const code = approvalCode(key, 'a', p.approvalId, p.bindingHash);
    const text = `${r.text}\n\n${deps.cfg.deliveryChannel === 'imessage' ? 'To approve, send:' : 'Tap Approve, or send:'} /papprove ${p.approvalId} ${code}`;
    if (deps.cfg.deliveryChannel === 'imessage') return { text };
    return {
      text,
      presentation: {
        title: `Approve ${p.kind}?`,
        blocks: [
          { type: 'text', text },
          {
            type: 'buttons',
            buttons: [
              { label: 'Approve', action: { type: 'callback', value: callbackData(key, 'a', p.approvalId, p.bindingHash) }, style: 'success' },
              { label: 'Deny', action: { type: 'callback', value: callbackData(key, 'd', p.approvalId, p.bindingHash) }, style: 'danger' },
            ],
          },
        ],
      },
    };
  };

  async function run(sub: string, args: string[], key: Buffer, ownerId: string, updateId: string, assertCurrent?: () => void): Promise<OwnerReply> {
    const sendIntent = async (key: Buffer, ownerId: string, updateId: string, intent: OwnerIntent) => {
      assertCurrent?.();
      const proof = signOwnerIngress(key, { source: deps.cfg.deliveryChannel ?? 'telegram', senderId: ownerId, chatId: ownerId, chatType: 'private', updateId, receivedAt: now().toISOString(), intent });
      return ingress<{ type: string; [k: string]: unknown }>(key, 'owner_intent', { proof });
    };
    switch (sub) {
      case 'help':
        return { text: HELP };
      case 'status': {
        const [c, p, r] = await rpcCalls(
          deps.cfg.ingressSocket,
          [{ method: 'controls' }, { method: 'list_pending' }, { method: 'recent', params: { limit: 5 } }],
          { ingressKey: key, timeoutMs },
        );
        if (!c?.ok) return { text: brokerError(c as { ok: false; error: { code: string; message: string } }) };
        const pending = p?.ok ? (p.result as ApprovalPreview[]) : [];
        const recent = r?.ok ? (r.result as ActionStatusView[]) : [];
        // Capability status from the daemon's read-only socket (WP-8), when configured. Read-only; failures are shown, not fatal.
        let caps: string | null = null;
        if (deps.cfg.readSocket) {
          const cs = await rpcCall<{ text?: string }>(deps.cfg.readSocket, 'status.text', {}, { timeoutMs });
          caps = cs.ok && typeof cs.result?.text === 'string' ? cs.result.text.split('\n').slice(1).join('\n') : `Capabilities: unavailable (${cs.ok ? 'bad response' : cs.error.code})`;
        }
        return {
          text: [
            'Potts status',
            renderControls(c.result as ControlSnapshot),
            `Pending approvals: ${pending.length}`,
            recent.length ? 'Recent actions:\n' + recent.map(renderActionLine).join('\n') : 'Recent actions: none',
            ...(caps ? [caps] : []),
          ].join('\n').slice(0, 3900),
        };
      }
      case 'approvals': {
        const p = await ingress<ApprovalPreview[]>(key, 'list_pending');
        if (!p.ok) return { text: brokerError(p) };
        if (!p.result.length) return { text: 'No pending approvals.' };
        const shown = p.result.slice(0, 10);
        return { text: [`Pending approvals (${p.result.length}):`, ...shown.map(renderPendingLine), p.result.length > 10 ? '…more not shown' : ''].filter(Boolean).join('\n') };
      }
      case 'pause':
      case 'resume': {
        const integration = args[0];
        if (integration !== undefined && !INTEGRATION_RE.test(integration)) return { text: 'Integration names are lowercase letters, digits, - or _.' };
        const intent: OwnerIntent =
          sub === 'pause'
            ? integration
              ? { type: 'pause_integration', integration, reason: 'owner /pause' }
              : { type: 'pause_all', reason: 'owner /pause' }
            : { type: 'resume', scope: integration ? `integration:${integration}` : 'global' };
        const r = await sendIntent(key, ownerId, updateId, intent);
        return { text: r.ok ? describeOutcome(r.result) : brokerError(r) };
      }
      case 'approve': {
        const [id, code] = args;
        if (!id || !APPROVAL_ID_PATTERN.test(id)) return { text: 'Usage: /papprove <approval-id>' };
        const pv = await ingress<ApprovalPreview | null>(key, 'preview', { approvalId: id });
        if (!pv.ok) return { text: brokerError(pv) };
        if (!pv.result) return { text: `No approval ${id}.` };
        if (code === undefined) return reviewReply(key, pv.result);
        if (pv.result.status !== 'pending') return { text: `Approval ${id} is ${pv.result.status}; nothing to approve.` };
        if (!renderPreview(pv.result).complete) return { text: 'This request is too large to approve in this chat.' };
        if (!verifyApprovalCode(key, 'a', id, pv.result.bindingHash, code)) {
          log('approve_code_rejected', { approvalId: id });
          return { text: 'That code does not match the current version of this request (it may have been revised). Review again with /papprove ' + id };
        }
        const r = await sendIntent(key, ownerId, updateId, { type: 'approve', approvalId: id, bindingHash: pv.result.bindingHash });
        return { text: r.ok ? describeOutcome(r.result) : brokerError(r) };
      }
      case 'deny': {
        const [id, ...rest] = args;
        if (!id || !APPROVAL_ID_PATTERN.test(id)) return { text: 'Usage: /deny <approval-id> [reason]' };
        const r = await sendIntent(key, ownerId, updateId, { type: 'deny', approvalId: id, reason: rest.join(' ').slice(0, 200) || 'owner denied' });
        return { text: r.ok ? describeOutcome(r.result) : brokerError(r) };
      }
      case 'cancel': {
        const [id] = args;
        let intent: OwnerIntent;
        if (id && APPROVAL_ID_PATTERN.test(id)) intent = { type: 'cancel_approval', approvalId: id, reason: 'owner /cancel' };
        else if (id && ACTION_ID_PATTERN.test(id)) intent = { type: 'cancel_action', actionId: id, reason: 'owner /cancel' };
        else return { text: 'Usage: /cancel <approval-id|action-id>' };
        const r = await sendIntent(key, ownerId, updateId, intent);
        return { text: r.ok ? describeOutcome(r.result) : brokerError(r) };
      }
      case 'revoke':
      case 'reinstate': {
        const [account, ...rest] = args;
        if (!account || !ACCOUNT_RE.test(account)) return { text: `Usage: /${sub === 'revoke' ? 'revoke' : 'potts reinstate'} <account-id>` };
        const intent: OwnerIntent = sub === 'revoke' ? { type: 'revoke_account', accountId: account, reason: rest.join(' ').slice(0, 200) || 'owner /revoke' } : { type: 'reinstate_account', accountId: account };
        const r = await sendIntent(key, ownerId, updateId, intent);
        return { text: r.ok ? describeOutcome(r.result) : brokerError(r) };
      }
      case 'testcall': {
        if (args.length) return { text: 'Usage: /potts testcall' };
        const r = await sendIntent(key, ownerId, updateId, { type: 'test_call' });
        return { text: r.ok ? describeOutcome(r.result) : brokerError(r) };
      }
      case 'remember': {
        const text = args.join(' ').trim();
        if (!text || text.length > 2000) return { text: 'Usage: /potts remember <fact or preference, up to 2000 characters>' };
        if (!deps.cfg.memoryControlSocket) return { text: 'Memory isn’t connected yet.' };
        assertCurrent?.();
        const proof = signOwnerControl(key, { source: deps.cfg.deliveryChannel ?? 'telegram', senderId: ownerId, updateId, receivedAt: now().toISOString(), control: { type: 'memory_remember', text } });
        const r = await rpcCall<{ memoryId: string }>(deps.cfg.memoryControlSocket, 'owner_remember', { proof }, { timeoutMs });
        return { text: r.ok ? `Got it—I’ll remember that. (${r.result.memoryId})` : brokerError(r) };
      }
      case 'forget': {
        const [memoryId] = args;
        if (!memoryId || !MEMORY_ID_RE.test(memoryId)) return { text: 'Usage: /forget <memory-id>' };
        if (!deps.cfg.memoryControlSocket) return { text: 'Memory forget is not connected yet (the memory service is wired by a later work package). Nothing was changed.' };
        assertCurrent?.();
        const proof = signOwnerControl(key, { source: deps.cfg.deliveryChannel ?? 'telegram', senderId: ownerId, updateId, receivedAt: now().toISOString(), control: { type: 'memory_forget', memoryId } });
        const r = await rpcCall<{ forgotten?: boolean }>(deps.cfg.memoryControlSocket, 'owner_forget', { proof }, { timeoutMs });
        return { text: r.ok ? `Forget request for ${memoryId} accepted.` : brokerError(r) };
      }
      default:
        return { text: HELP };
    }
  }

  return {
    /** Handler for a registered command name (see COMMAND_ALIASES). */
    async handleCommand(commandName: string, ctx: CommandContextLike): Promise<OwnerReply> {
      const mapped = COMMAND_ALIASES[commandName];
      if (!mapped) return { text: NOT_AVAILABLE };
      if (!deps.cfg.ownerControls) return { text: NOT_AVAILABLE };
      const secrets = await deps.secrets.get();
      const g = checkOwnerCommand(ctx, secrets?.ownerId ?? null, deps.cfg.deliveryChannel ?? 'telegram');
      if (!g.ok || !secrets) {
        log('owner_command_rejected', { command: commandName, reason: g.ok ? 'secrets_unavailable' : g.reason, channel: ctx.channel });
        return { text: NOT_AVAILABLE };
      }
      let args = tokens(ctx.args);
      let sub: string = mapped;
      if (mapped === 'root') {
        sub = args[0]?.toLowerCase() ?? 'help';
        args = args.slice(1);
        if (!(OWNER_SUBCOMMANDS as readonly string[]).includes(sub)) sub = 'help';
      }
      // Commands carry no Telegram update_id in the plugin context (OpenClaw 2026.9.8), so each
      // invocation gets a fresh single-use reference; approvals are additionally bound by code + binding hash.
      const updateId = `cmd:${newRef()}`;
      replay.claim(updateId);
      ctx.assertOwnerCurrent?.();
      return run(sub, args, secrets.key, secrets.ownerId, updateId, ctx.assertOwnerCurrent);
    },

    /** Telegram interactive handler for namespace "potts". */
    async handleCallback(ctx: CallbackContextLike): Promise<{ handled: true; reply: OwnerReply; clearButtons: boolean }> {
      const deny = (reason: string, text = NOT_AVAILABLE) => {
        log('owner_callback_rejected', { reason });
        return { handled: true as const, reply: { text }, clearButtons: false };
      };
      if (!deps.cfg.ownerControls || deps.cfg.deliveryChannel === 'imessage') return deny('disabled');
      const secrets = await deps.secrets.get();
      const g = checkOwnerCallback(ctx, secrets?.ownerId ?? null);
      if (!g.ok || !secrets) return deny(g.ok ? 'secrets_unavailable' : g.reason);
      const parsed = parseCallbackPayload(ctx.callback.payload);
      if (!parsed.ok) return deny(parsed.reason, parsed.reason === 'missing_nonce' ? 'This button is not valid (missing confirmation code).' : NOT_AVAILABLE);
      const updateId = `cb:${ctx.callbackId}`;
      if (!replay.claim(updateId)) return deny('replayed', 'This button press was already handled.');
      const pv = await ingress<ApprovalPreview | null>(secrets.key, 'preview', { approvalId: parsed.approvalId });
      if (!pv.ok) return { handled: true, reply: { text: brokerError(pv) }, clearButtons: false };
      if (!pv.result) return deny('unknown_approval', `No approval ${parsed.approvalId}.`);
      if (!verifyApprovalCode(secrets.key, parsed.action, parsed.approvalId, pv.result.bindingHash, parsed.code)) {
        return deny('code_mismatch', `This button no longer matches request ${parsed.approvalId} (it changed or expired). Review again with /papprove ${parsed.approvalId}`);
      }
      if (pv.result.status !== 'pending') return { handled: true, reply: { text: `Approval ${parsed.approvalId} is ${pv.result.status}.` }, clearButtons: true };
      if (parsed.action === 'a' && !renderPreview(pv.result).complete) return deny('too_large', 'This request is too large to approve in this chat.');
      const intent: OwnerIntent =
        parsed.action === 'a' ? { type: 'approve', approvalId: parsed.approvalId, bindingHash: pv.result.bindingHash } : { type: 'deny', approvalId: parsed.approvalId, reason: 'owner tapped Deny' };
      const r = await sendIntent(secrets.key, secrets.ownerId, updateId, intent);
      return { handled: true, reply: { text: r.ok ? describeOutcome(r.result) : brokerError(r) }, clearButtons: r.ok };
    },

    /** Builds the approval prompt the OwnerChannel sends (same content and buttons as /papprove). */
    async approvalPrompt(approvalId: string): Promise<{ ok: true; reply: OwnerReply } | { ok: false; error: string }> {
      if (!APPROVAL_ID_PATTERN.test(approvalId)) return { ok: false, error: 'bad approval id' };
      const secrets = await deps.secrets.get();
      if (!secrets) return { ok: false, error: 'owner controls not configured' };
      const pv = await ingress<ApprovalPreview | null>(secrets.key, 'preview', { approvalId });
      if (!pv.ok) return { ok: false, error: pv.error.code };
      if (!pv.result) return { ok: false, error: 'not_found' };
      return { ok: true, reply: reviewReply(secrets.key, pv.result) };
    },
  };
}
export type OwnerHandlers = ReturnType<typeof createOwnerHandlers>;
