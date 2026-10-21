/**
 * OwnerChannel: how the Potts daemon sends notifications to the owner.
 *
 * Potts never talks to the Telegram Bot API and never polls it: the OpenClaw
 * gateway is the single consumer of the bot. Delivery goes through the
 * gateway's existing Telegram channel, by one of two supported routes:
 *
 *  1. `plugin-socket` (preferred): the potts-broker plugin's background
 *     service listens on $POTTS_HOME/run/owner-channel.sock. HMAC
 *     challenge-response with the ingress key, then `notify` /
 *     `notify_approval`. The plugin fixes the recipient to the owner id and
 *     renders approval prompts itself (exact content + bound buttons).
 *  2. `openclaw-cli` (fallback): `openclaw message send --channel telegram
 *     --target <owner>` (the documented CLI over the gateway `send` RPC).
 *     Message text is passed in argv, which other local users can see with
 *     `ps`, so this route refuses long texts and is meant for short,
 *     non-sensitive notices only.
 */
import { execFile } from 'node:child_process';
import { connectSocket } from '../broker/server.ts';
import { hmacSha256Hex } from '../core/hash.ts';
import { ok, perr, type Result } from '../core/result.ts';

export interface OwnerMessage {
  text: string;
  silent?: boolean;
  quietHours?: import('../notifications/quiet-hours.ts').QuietHoursConfig;
  expectedDestination?: {channel:string;target:string};
}

export interface OwnerChannel {
  readonly kind: 'plugin-socket' | 'openclaw-cli' | 'fake';
  /** Plain notification to the owner's private chat. */
  notify(msg: OwnerMessage): Promise<Result<{ messageId: string | null; accepted?: true }>>;
  /** Approval prompt with the exact content and bound Approve/Deny buttons. */
  notifyApproval(approvalId: string): Promise<Result<{ messageId: string | null; accepted?: true }>>;
}

export const OWNER_TEXT_LIMIT = 3500;

/** Transport failures are reported as code 'internal' with details.reason = 'unavailable'. */
const unavailable = (message: string) => perr('internal', message, { reason: 'unavailable' });

export function ownerChannelAuthResponse(key: string | Uint8Array, challenge: string): string {
  return hmacSha256Hex(key, `potts-owner-channel:v1:${challenge}`);
}

export function createPluginSocketOwnerChannel(o: { socketPath: string; key: string | Uint8Array; timeoutMs?: number }): OwnerChannel {
  const call = async (method: string, params: Record<string, unknown>): Promise<Result<{ messageId: string | null; accepted?: true }>> => {
    let client;
    try {
      client = await connectSocket(o.socketPath, { expectGreeting: true });
    } catch {
      return unavailable('owner channel socket unavailable (is the potts-broker plugin running with ownerChannel enabled?)');
    }
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), o.timeoutMs ?? 15_000).unref());
    try {
      const greeting = (await Promise.race([client.greeting, timeout])) as { challenge?: string } | 'timeout';
      if (greeting === 'timeout' || typeof greeting?.challenge !== 'string') return unavailable('owner channel did not send a challenge');
      const auth = await Promise.race([client.call('auth', { mac: ownerChannelAuthResponse(o.key, greeting.challenge) }), timeout]);
      if (auth === 'timeout' || !auth.ok) return perr('ingress_invalid', 'owner channel authentication failed');
      const r = await Promise.race([client.call(method, params), timeout]);
      if (r === 'timeout') return perr('internal', 'Owner message delivery is unconfirmed after timeout; do not resend automatically');
      if (!r.ok) {
        if (r.error?.code === 'quiet_deferred') return perr('held', 'Reminder held until morning', (r.error as {details?:Record<string,unknown>}).details);
        return r.error?.code === 'invalid_input' ? perr('invalid_input', r.error.message) : r.error?.code === 'rate_limited' ? unavailable('Owner channel rate limit reached before dispatch') : perr('internal', r.error?.message ?? 'Owner message delivery is unconfirmed');
      }
      const res = r.result as { messageId?: string | null; accepted?: boolean } | undefined;
      const messageId = typeof res?.messageId === 'string' && res.messageId.trim() && !['ok','unknown'].includes(res.messageId) ? res.messageId : null;
      if (!messageId && res?.accepted !== true) return perr('internal', 'Owner message acceptance was not confirmed');
      return ok({ messageId, accepted: true });
    } finally {
      client.close();
    }
  };
  return {
    kind: 'plugin-socket',
    notify: (m) => {
      if (!m.text.trim() || m.text.length > OWNER_TEXT_LIMIT) return Promise.resolve(perr('invalid_input', `text must be 1..${OWNER_TEXT_LIMIT} characters`));
      return call('notify', { text: m.text, silent: m.silent === true, ...(m.quietHours ? {quietHours:m.quietHours} : {}),...(m.expectedDestination?{expectedDestination:m.expectedDestination}:{}) });
    },
    notifyApproval: (approvalId) => call('notify_approval', { approvalId }),
  };
}

export type ExecRunner = (file: string, args: string[], opts: { timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultExec: ExecRunner = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeoutMs, env: opts.env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** Fallback route. Short, non-sensitive text only (argv is visible to local users). */
export function createOpenClawCliOwnerChannel(o: {
  ownerChatId: string;
  openclawBin: string;
  profile?: string;
  accountId?: string;
  maxChars?: number;
  dryRun?: boolean;
  exec?: ExecRunner;
  env?: NodeJS.ProcessEnv;
}): OwnerChannel {
  if (!/^[1-9][0-9]{0,19}$/.test(o.ownerChatId)) throw new Error('ownerChatId must be a numeric Telegram id');
  const maxChars = o.maxChars ?? 300;
  const exec = o.exec ?? defaultExec;
  const send = async (text: string, silent: boolean): Promise<Result<{ messageId: string | null; accepted?: true }>> => {
    if (!text.trim() || text.length > maxChars) return perr('invalid_input', `CLI route accepts 1..${maxChars} characters (argv is visible to local users)`);
    const args = [
      ...(o.profile ? ['--profile', o.profile] : []),
      'message', 'send', '--channel', 'telegram', '--target', o.ownerChatId, '--message', text, '--json',
      ...(o.accountId ? ['--account', o.accountId] : []),
      ...(silent ? ['--silent'] : []),
      ...(o.dryRun ? ['--dry-run'] : []),
    ];
    const env = { ...(o.env ?? process.env) };
    for (const k of Object.keys(env)) if (k.startsWith('OPENCLAW_') && o.profile) delete env[k];
    const r = await exec(o.openclawBin, args, { timeoutMs: 30_000, env });
    if (r.code !== 0) return perr('internal', `Message delivery is unconfirmed (exit ${r.code}); do not retry automatically`);
    let messageId: string | null = null;
    try {
      const j = JSON.parse(r.stdout) as { messageId?: unknown; result?: { messageId?: unknown } };
      const id = j.messageId ?? j.result?.messageId;
      if (typeof id === 'string' || typeof id === 'number') messageId = String(id);
    } catch {
      /* non-JSON output: delivery status unknown but CLI exited 0 */
    }
    if (!messageId || o.dryRun) return perr('internal', 'Message delivery was not confirmed');
    return ok({ messageId });
  };
  return {
    kind: 'openclaw-cli',
    notify: (m) => m.quietHours || m.expectedDestination ? Promise.resolve(perr('invalid_input','Reminder delivery requires the verified plugin channel')) : send(m.text, m.silent === true),
    // Content never goes through argv: the owner is told to review in the LLM-free command.
    notifyApproval: (approvalId) => send(`Potts needs your approval. Review it with /papprove ${approvalId}`, false),
  };
}

export interface FakeOwnerChannel extends OwnerChannel {
  readonly sent: ({ type: 'text'; text: string; silent: boolean } | { type: 'approval'; approvalId: string })[];
  failNext: boolean;
}

export function createFakeOwnerChannel(): FakeOwnerChannel {
  const ch: FakeOwnerChannel = {
    kind: 'fake',
    sent: [],
    failNext: false,
    async notify(m) {
      if (ch.failNext) {
        ch.failNext = false;
        return unavailable('fake failure');
      }
      ch.sent.push({ type: 'text', text: m.text, silent: m.silent === true });
      return ok({ messageId: String(ch.sent.length) });
    },
    async notifyApproval(approvalId) {
      if (ch.failNext) {
        ch.failNext = false;
        return unavailable('fake failure');
      }
      ch.sent.push({ type: 'approval', approvalId });
      return ok({ messageId: String(ch.sent.length) });
    },
  };
  return ch;
}
