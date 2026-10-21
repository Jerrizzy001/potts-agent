import { withTransaction } from '../store/db.ts';
import { ok, perr, type Result } from '../core/result.ts';
import { consumeIngressOnce, type IngressVerifier, type OwnerIntent, type VerifiedOwnerIngress } from '../approvals/ingress.ts';
import type { ApprovalRecord } from '../approvals/store.ts';
import type { AccountRegistry } from '../core/config.ts';
import type { ActionStatusView, Broker, ControlSnapshot, ProposeOutcome } from './broker.ts';
import type { AttachmentRef } from '../policy/action.ts';

/** Everything the owner must see to approve an exact action. Rendered by WP-2's trusted ingress. */
export interface ApprovalPreview {
  approvalId: string;
  bindingHash: string;
  expiresAt: string;
  status: string;
  actionId: string;
  kind: string;
  /** Proposer's rationale. Untrusted text: display as data, never as authority. */
  summary: string | null;
  account: { id: string; address: string; kind: string } | null;
  destination: string[];
  payload: unknown;
  attachments: AttachmentRef[];
  policyVersion: string;
  proposedBy: string;
}

export type OwnerOutcome =
  | { type: 'approved'; approval: ApprovalRecord }
  | { type: 'approval_closed'; approval: ApprovalRecord }
  | { type: 'action_cancelled'; action: ActionStatusView }
  | { type: 'direct_instruction'; outcome: ProposeOutcome }
  | { type: 'controls'; controls: ControlSnapshot }
  | { type: 'test_call'; incidentId: string; message: string };

/**
 * Optional trusted extensions wired by the daemon (WP-9). They run only for a
 * verified, single-use owner proof.
 * - testCall: queues a `test` owner-alert call; runs inside the ingress transaction, must be synchronous and
 *   must refuse (Result error) when calls are disabled or not allowed now (quiet hours).
 * - afterIntent: called after the ingress transaction committed successfully (e.g. purge an account's synced
 *   data after revoke_account). Errors are swallowed; it must only move towards safety.
 */
export interface OwnerControlExtensions {
  testCall?: (actor: string, ref: string) => Result<{ incidentId: string; message: string }>;
  afterIntent?: (intent: OwnerIntent, actor: string, outcome: OwnerOutcome) => void;
}

/**
 * Owner controls. Mutations require a proof signed by the trusted ingress
 * (verified, fresh, from the owner's sender id, update id never used before).
 * Read-only views are plain functions for in-process trusted callers and the
 * authenticated ingress socket — never exposed on the proposer socket.
 */
export interface OwnerControls {
  handle(proof: unknown): Result<OwnerOutcome>;
  listPendingApprovals(): ApprovalPreview[];
  preview(approvalId: string): ApprovalPreview | undefined;
  recentActions(limit?: number): ActionStatusView[];
  controls(): ControlSnapshot;
}

export function createOwnerControls(broker: Broker, verifier: IngressVerifier, accounts: AccountRegistry, ext: OwnerControlExtensions = {}): OwnerControls {
  const { db, clock, audit, approvals } = broker;

  const preview = (approvalId: string): ApprovalPreview | undefined => {
    const apr = approvals.get(approvalId);
    if (!apr) return undefined;
    const a = broker.getAction(apr.actionId);
    if (!a) return undefined;
    const acct = a.accountId ? accounts.get(a.accountId) : undefined;
    return {
      approvalId: apr.id, bindingHash: apr.bindingHash, expiresAt: apr.expiresAt, status: apr.status, actionId: a.id, kind: a.kind, summary: a.summary,
      account: acct ? { id: acct.id, address: acct.address, kind: acct.kind } : null, destination: a.destination, payload: a.payload,
      attachments: a.attachments, policyVersion: apr.binding.policyVersion, proposedBy: a.actor,
    };
  };

  const apply = (v: VerifiedOwnerIngress, intent: OwnerIntent): Result<OwnerOutcome> => {
    const who = v.actor;
    switch (intent.type) {
      case 'approve': {
        const apr = approvals.get(intent.approvalId);
        if (!apr) return perr('not_found', 'approval not found');
        const a = broker.getAction(apr.actionId);
        if (!a) return perr('not_found', 'action not found');
        if (a.status !== 'awaiting_approval') return perr('action_state', `action is ${a.status}`);
        const r = approvals.grant(apr.id, intent.bindingHash, v, { action: a, policy: broker.currentPolicy() });
        if (!r.ok) return r;
        db.prepare("UPDATE actions SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'awaiting_approval'").run(clock.nowIso(), a.id);
        return ok({ type: 'approved', approval: r.value });
      }
      case 'deny':
      case 'cancel_approval': {
        const r = approvals.close(intent.approvalId, intent.type === 'deny' ? 'denied' : 'cancelled', who, intent.reason ?? `owner ${intent.type}`);
        if (!r.ok) return r;
        if (intent.type === 'deny') {
          const c = broker._cancelAction(r.value.actionId, who, 'owner denied approval');
          if (!c.ok && c.error.code !== 'action_state') return c;
        }
        return ok({ type: 'approval_closed', approval: r.value });
      }
      case 'cancel_action': {
        const r = broker._cancelAction(intent.actionId, who, intent.reason ?? 'owner cancelled');
        return r.ok ? ok({ type: 'action_cancelled', action: r.value }) : r;
      }
      case 'direct_instruction': {
        const r = broker._proposeDirect(intent.action, v);
        return r.ok ? ok({ type: 'direct_instruction', outcome: r.value }) : r;
      }
      case 'pause_all':
        broker._setControl('global', 'paused', who, intent.reason ?? 'owner pause');
        return ok({ type: 'controls', controls: broker.controls() });
      case 'pause_integration':
        if (typeof intent.integration !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(intent.integration)) return perr('invalid_input', 'bad integration name');
        broker._setControl(`integration:${intent.integration}`, 'paused', who, intent.reason ?? 'owner pause');
        return ok({ type: 'controls', controls: broker.controls() });
      case 'resume':
        if (intent.scope !== 'global' && !/^integration:[a-z0-9_-]{1,32}$/.test(intent.scope)) return perr('invalid_input', 'bad resume scope');
        broker._setControl(intent.scope, null, who, null);
        return ok({ type: 'controls', controls: broker.controls() });
      case 'revoke_account': {
        if (!accounts.get(intent.accountId)) return perr('not_found', 'unknown account');
        broker._setControl(`account:${intent.accountId}`, 'revoked', who, intent.reason ?? 'owner revocation');
        approvals.invalidateForAccount(intent.accountId, 'account revoked', who);
        return ok({ type: 'controls', controls: broker.controls() });
      }
      case 'reinstate_account':
        broker._setControl(`account:${intent.accountId}`, null, who, null);
        return ok({ type: 'controls', controls: broker.controls() });
      case 'test_call': {
        if (!ext.testCall) return perr('no_executor', 'owner test calls are not available (telephony is not wired)');
        const r = ext.testCall(who, v.ref);
        if (!r.ok) return r;
        audit.append({ type: 'owner_test_call', actor: who, data: { incidentId: r.value.incidentId, ref: v.ref } });
        return ok({ type: 'test_call', incidentId: r.value.incidentId, message: r.value.message });
      }
    }
  };

  const controls: OwnerControls = {
    handle(proof) {
      const v = verifier.verify(proof);
      if (!v.ok) {
        audit.append({ type: 'ingress_rejected', actor: 'ingress', data: { code: v.error.code, message: v.error.message } });
        return v;
      }
      const res = withTransaction(db, () => {
        const once = consumeIngressOnce(db, v.value, clock);
        if (!once.ok) {
          audit.append({ type: 'ingress_rejected', actor: v.value.actor, data: { code: once.error.code, ref: v.value.ref } });
          return once;
        }
        const r = apply(v.value, v.value.proof.intent);
        if (!r.ok) audit.append({ type: 'ingress_rejected', actor: v.value.actor, data: { code: r.error.code, message: r.error.message, ref: v.value.ref, intent: v.value.proof.intent.type } });
        return r;
      });
      if (res.ok && ext.afterIntent) {
        try {
          ext.afterIntent(v.value.proof.intent, v.value.actor, res.value as OwnerOutcome);
        } catch {
          /* the owner intent itself is committed; follow-up work reports its own problems */
        }
      }
      return res;
    },
    listPendingApprovals: () => approvals.listPending().map((a) => preview(a.id)!).filter(Boolean),
    preview,
    recentActions: (limit = 20) => broker.list({ limit }),
    controls: () => broker.controls(),
  };
  return controls;
}
