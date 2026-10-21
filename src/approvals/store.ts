import type { Db } from '../store/db.ts';
import type { AuditLedger } from '../audit/ledger.ts';
import { systemClock, type Clock } from '../core/clock.ts';
import { newId } from '../core/ids.ts';
import { canonicalJson } from '../core/hash.ts';
import { ok, perr, type Result } from '../core/result.ts';
import type { LoadedPolicy } from '../policy/document.ts';
import { bindingFor, bindingHash, type ApprovalBinding, type BindableAction } from './binding.ts';
import { isVerifiedOwnerIngress, type VerifiedOwnerIngress } from './ingress.ts';

export type ApprovalStatus = 'pending' | 'approved' | 'used' | 'denied' | 'cancelled' | 'expired' | 'invalidated';

export interface ApprovalRecord {
  id: string;
  actionId: string;
  status: ApprovalStatus;
  source: 'request' | 'direct_instruction';
  binding: ApprovalBinding;
  bindingHash: string;
  accountId: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  ingressRef: string | null;
  usedAt: string | null;
  usedByDispatch: string | null;
  statusReason: string | null;
}

type Row = {
  id: string; action_id: string; status: string; source: string; binding_json: string; binding_hash: string; account_id: string | null;
  created_at: string; expires_at: string; decided_at: string | null; decided_by: string | null; ingress_ref: string | null;
  used_at: string | null; used_by_dispatch: string | null; status_reason: string | null;
};
const toRecord = (r: Row): ApprovalRecord => ({
  id: r.id, actionId: r.action_id, status: r.status as ApprovalStatus, source: r.source as ApprovalRecord['source'],
  binding: JSON.parse(r.binding_json) as ApprovalBinding, bindingHash: r.binding_hash, accountId: r.account_id, createdAt: r.created_at,
  expiresAt: r.expires_at, decidedAt: r.decided_at, decidedBy: r.decided_by, ingressRef: r.ingress_ref, usedAt: r.used_at,
  usedByDispatch: r.used_by_dispatch, statusReason: r.status_reason,
});

/**
 * Approval records. All mutating methods must be called inside a broker
 * transaction; they append audit entries but do not open transactions.
 * Owner decisions require a VerifiedOwnerIngress (see ingress.ts).
 */
export interface ApprovalStore {
  get(id: string): ApprovalRecord | undefined;
  /** The pending/approved approval for an action, if any. */
  live(actionId: string): ApprovalRecord | undefined;
  listPending(): ApprovalRecord[];
  /** Creates a pending request bound to the action's current content and policy. */
  request(action: BindableAction, policy: LoadedPolicy, opts?: { ttlSeconds?: number }): ApprovalRecord;
  /** Owner approval of a pending request; intent.bindingHash must match what the owner was shown. */
  grant(approvalId: string, expectedBindingHash: string, by: VerifiedOwnerIngress, current: { action: BindableAction; policy: LoadedPolicy }): Result<ApprovalRecord>;
  /** A fully specified direct owner instruction: create an already-approved record. */
  createDirect(action: BindableAction, policy: LoadedPolicy, by: VerifiedOwnerIngress): ApprovalRecord;
  close(approvalId: string, status: 'denied' | 'cancelled' | 'invalidated' | 'expired', actor: string, reason: string): Result<ApprovalRecord>;
  /**
   * Validates the live approval of an action for execution against its CURRENT
   * content and policy. Expired → marked expired; mismatched → invalidated.
   */
  checkForExecution(action: BindableAction, policy: LoadedPolicy): Result<ApprovalRecord>;
  /** Atomically marks an approved record used (single use). False if it was not 'approved'. */
  consume(approvalId: string, dispatchId: string): boolean;
  /** Returns a used approval to 'approved' after reconciliation proved the dispatch never reached the provider. */
  release(approvalId: string, reason: string): void;
  /** Invalidates all live approvals of an action (e.g. after revision). */
  invalidateLive(actionId: string, reason: string, actor: string): void;
  /** Invalidates live approvals of every action on an account (revocation). */
  invalidateForAccount(accountId: string, reason: string, actor: string): number;
}

export function createApprovalStore(db: Db, audit: AuditLedger, clock: Clock = systemClock): ApprovalStore {
  const getRow = (id: string) => db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
  const setStatus = (id: string, status: ApprovalStatus, reason: string | null, extra: { decidedBy?: string } = {}) => {
    db.prepare('UPDATE approvals SET status = ?, status_reason = ?, decided_at = COALESCE(decided_at, ?), decided_by = COALESCE(decided_by, ?) WHERE id = ?').run(
      status, reason, clock.nowIso(), extra.decidedBy ?? null, id,
    );
  };
  const insert = (action: BindableAction, policy: LoadedPolicy, status: 'pending' | 'approved', source: 'request' | 'direct_instruction', ttlSeconds: number, by?: VerifiedOwnerIngress): ApprovalRecord => {
    const binding = bindingFor(action, policy);
    const id = newId('apr', clock);
    const ttl = Math.min(ttlSeconds, policy.doc.maxApprovalTtlSeconds);
    const now = clock.nowIso();
    db.prepare(
      `INSERT INTO approvals (id, action_id, status, source, binding_json, binding_hash, account_id, created_at, expires_at, decided_at, decided_by, ingress_ref)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, action.id, status, source, canonicalJson(binding), bindingHash(binding), action.accountId, now, new Date(clock.nowMs() + ttl * 1000).toISOString(),
      status === 'approved' ? now : null, by?.actor ?? null, by?.ref ?? null);
    return toRecord(getRow(id)!);
  };
  const store: ApprovalStore = {
    get: (id) => {
      const r = getRow(id);
      return r ? toRecord(r) : undefined;
    },
    live: (actionId) => {
      const r = db.prepare("SELECT * FROM approvals WHERE action_id = ? AND status IN ('pending','approved')").get(actionId) as Row | undefined;
      return r ? toRecord(r) : undefined;
    },
    listPending: () => (db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC").all() as Row[]).map(toRecord),
    request(action, policy, opts = {}) {
      const rec = insert(action, policy, 'pending', 'request', opts.ttlSeconds ?? policy.doc.approvalTtlSeconds);
      audit.append({ type: 'approval_requested', actor: 'broker', actionId: action.id, data: { approvalId: rec.id, bindingHash: rec.bindingHash, expiresAt: rec.expiresAt } });
      return rec;
    },
    grant(approvalId, expectedHash, by, current) {
      if (!isVerifiedOwnerIngress(by)) return perr('ingress_invalid', 'approval requires verified owner ingress');
      const r = getRow(approvalId);
      if (!r) return perr('not_found', 'approval not found');
      const rec = toRecord(r);
      if (rec.status !== 'pending') return perr('approval_not_pending', `approval is ${rec.status}`);
      if (Date.parse(rec.expiresAt) <= clock.nowMs()) {
        store.close(rec.id, 'expired', 'broker', 'expired before owner decision');
        return perr('approval_expired', 'approval request expired');
      }
      if (rec.bindingHash !== expectedHash) return perr('approval_mismatch', 'owner approved a different version of this action');
      const now = bindingHash(bindingFor(current.action, current.policy));
      if (now !== rec.bindingHash) {
        store.close(rec.id, 'invalidated', 'broker', 'action or policy changed since the request was created');
        return perr('approval_mismatch', 'action or policy changed since the request was shown');
      }
      db.prepare("UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = ?, ingress_ref = ? WHERE id = ? AND status = 'pending'").run(clock.nowIso(), by.actor, by.ref, rec.id);
      audit.append({ type: 'approval_granted', actor: by.actor, actionId: rec.actionId, data: { approvalId: rec.id, bindingHash: rec.bindingHash, ingressRef: by.ref } });
      return ok(toRecord(getRow(rec.id)!));
    },
    createDirect(action, policy, by) {
      if (!isVerifiedOwnerIngress(by)) throw new Error('createDirect requires verified owner ingress');
      store.invalidateLive(action.id, 'superseded by direct owner instruction', by.actor);
      const rec = insert(action, policy, 'approved', 'direct_instruction', policy.doc.approvalTtlSeconds, by);
      audit.append({ type: 'approval_granted', actor: by.actor, actionId: action.id, data: { approvalId: rec.id, bindingHash: rec.bindingHash, ingressRef: by.ref, source: 'direct_instruction' } });
      return rec;
    },
    close(approvalId, status, actor, reason) {
      const r = getRow(approvalId);
      if (!r) return perr('not_found', 'approval not found');
      if (r.status !== 'pending' && r.status !== 'approved') return perr('approval_not_pending', `approval is ${r.status}`);
      setStatus(approvalId, status, reason, { decidedBy: actor });
      const type = status === 'denied' ? 'approval_denied' : status === 'cancelled' ? 'approval_cancelled' : status === 'expired' ? 'approval_expired' : 'approval_invalidated';
      audit.append({ type, actor, actionId: r.action_id, data: { approvalId, reason } });
      return ok(toRecord(getRow(approvalId)!));
    },
    checkForExecution(action, policy) {
      const rec = store.live(action.id);
      if (!rec) {
        const used = db.prepare("SELECT id FROM approvals WHERE action_id = ? AND status = 'used'").get(action.id);
        return used ? perr('approval_used', 'the approval for this action was already used') : perr('approval_missing', 'no owner approval for this action');
      }
      if (rec.status === 'pending') return perr('approval_missing', 'approval is still pending owner decision');
      if (rec.binding.actionId !== action.id || rec.accountId !== action.accountId || rec.binding.accountId !== action.accountId) {
        store.close(rec.id, 'invalidated', 'broker', 'cross-action or cross-account use');
        return perr('approval_mismatch', 'approval belongs to a different action or account');
      }
      if (Date.parse(rec.expiresAt) <= clock.nowMs()) {
        store.close(rec.id, 'expired', 'broker', 'expired before execution');
        return perr('approval_expired', 'approval expired');
      }
      const current = bindingFor(action, policy);
      if (bindingHash(current) !== rec.bindingHash) {
        const changed = (Object.keys(current) as (keyof ApprovalBinding)[]).filter((k) => canonicalJson(current[k]) !== canonicalJson(rec.binding[k]));
        store.close(rec.id, 'invalidated', 'broker', `changed since approval: ${changed.join(', ') || 'binding'}`);
        return perr('approval_mismatch', `action changed since approval (${changed.join(', ')})`, { changed });
      }
      return ok(rec);
    },
    consume(approvalId, dispatchId) {
      const r = db.prepare("UPDATE approvals SET status = 'used', used_at = ?, used_by_dispatch = ? WHERE id = ? AND status = 'approved'").run(clock.nowIso(), dispatchId, approvalId);
      if (Number(r.changes) !== 1) return false;
      audit.append({ type: 'approval_consumed', actor: 'broker', actionId: getRow(approvalId)!.action_id, data: { approvalId, dispatchId } });
      return true;
    },
    release(approvalId, reason) {
      const r = db.prepare("UPDATE approvals SET status = 'approved', used_at = NULL, used_by_dispatch = NULL WHERE id = ? AND status = 'used'").run(approvalId);
      if (Number(r.changes) === 1) audit.append({ type: 'approval_released', actor: 'broker', actionId: getRow(approvalId)!.action_id, data: { approvalId, reason } });
    },
    invalidateLive(actionId, reason, actor) {
      const rec = store.live(actionId);
      if (rec) store.close(rec.id, 'invalidated', actor, reason);
    },
    invalidateForAccount(accountId, reason, actor) {
      const rows = db.prepare("SELECT id FROM approvals WHERE account_id = ? AND status IN ('pending','approved')").all(accountId) as { id: string }[];
      for (const r of rows) store.close(r.id, 'invalidated', actor, reason);
      return rows.length;
    },
  };
  return store;
}
