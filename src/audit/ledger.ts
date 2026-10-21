import type { Db } from '../store/db.ts';
import { canonicalJson, sha256Hex } from '../core/hash.ts';
import { newId } from '../core/ids.ts';
import { systemClock, type Clock } from '../core/clock.ts';
import { redact } from '../core/log.ts';

export const AUDIT_TYPES = [
  'action_proposed', 'action_revised', 'policy_decision', 'approval_requested', 'approval_granted', 'approval_denied',
  'approval_cancelled', 'approval_invalidated', 'approval_expired', 'approval_consumed', 'approval_released',
  'execute_rejected', 'dispatch_intent', 'dispatch_receipt', 'dispatch_failed', 'dispatch_uncertain',
  'reconciliation', 'recovery', 'pause', 'resume', 'revocation', 'reinstatement', 'ingress_rejected', 'action_cancelled',
  // WP-8 daemon: lifecycle, backup/restore, integrity checks, worker isolation runs, owner memory controls.
  'daemon_lifecycle', 'backup', 'restore', 'integrity_alert', 'isolation_run', 'memory_control',
  // WP-9: account data purge on revocation, policy hot reload, owner test call requests.
  'account_purge', 'policy_reload', 'owner_test_call',
] as const;
export type AuditType = (typeof AUDIT_TYPES)[number];

export interface AuditInput {
  type: AuditType;
  actor: string;
  actionId?: string | null;
  /** Must not contain secrets or full message bodies; store hashes. Redacted defensively. */
  data?: Record<string, unknown>;
}

export interface AuditEntry {
  seq: number;
  id: string;
  at: string;
  type: AuditType;
  actor: string;
  actionId: string | null;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);

export function entryHash(e: Omit<AuditEntry, 'hash'>): string {
  return sha256Hex(
    canonicalJson({ seq: e.seq, id: e.id, at: e.at, type: e.type, actor: e.actor, actionId: e.actionId, data: e.data, prevHash: e.prevHash }),
  );
}

export type AuditVerifyResult = { ok: true; entries: number; head: string } | { ok: false; brokenAtSeq: number; reason: string };

export interface AuditLedger {
  /** Appends an entry chained to the previous one. Call inside the same transaction as the state change it records. */
  append(input: AuditInput): AuditEntry;
  /** Recomputes the whole chain; detects edited, deleted, reordered or inserted rows. */
  verify(): AuditVerifyResult;
  list(opts?: { actionId?: string; limit?: number; afterSeq?: number }): AuditEntry[];
  head(): { seq: number; hash: string };
}

type Row = { seq: number; id: string; at: string; type: string; actor: string; action_id: string | null; data_json: string; prev_hash: string; hash: string };
const toEntry = (r: Row): AuditEntry => ({
  seq: r.seq, id: r.id, at: r.at, type: r.type as AuditType, actor: r.actor, actionId: r.action_id,
  data: JSON.parse(r.data_json) as Record<string, unknown>, prevHash: r.prev_hash, hash: r.hash,
});

export function createAuditLedger(db: Db, clock: Clock = systemClock): AuditLedger {
  const headStmt = db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1');
  const insert = db.prepare('INSERT INTO audit_log (seq, id, at, type, actor, action_id, data_json, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)');
  const head = () => {
    const r = headStmt.get() as { seq: number; hash: string } | undefined;
    return r ?? { seq: 0, hash: GENESIS_HASH };
  };
  return {
    append(input) {
      if (!(AUDIT_TYPES as readonly string[]).includes(input.type)) throw new Error(`unknown audit type ${input.type}`);
      const h = head();
      const base = {
        seq: h.seq + 1,
        id: newId('aud', clock),
        at: clock.nowIso(),
        type: input.type,
        actor: input.actor,
        actionId: input.actionId ?? null,
        data: JSON.parse(canonicalJson(redact(input.data ?? {}))) as Record<string, unknown>,
        prevHash: h.hash,
      };
      const entry: AuditEntry = { ...base, hash: entryHash(base) };
      insert.run(entry.seq, entry.id, entry.at, entry.type, entry.actor, entry.actionId, canonicalJson(entry.data), entry.prevHash, entry.hash);
      return entry;
    },
    verify() {
      let prev = GENESIS_HASH;
      let expectedSeq = 1;
      let n = 0;
      for (const r of db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').iterate() as Iterable<Row>) {
        if (r.seq !== expectedSeq) return { ok: false, brokenAtSeq: r.seq, reason: `sequence gap: expected ${expectedSeq}` };
        if (r.prev_hash !== prev) return { ok: false, brokenAtSeq: r.seq, reason: 'prev_hash does not match previous entry' };
        let e: AuditEntry;
        try {
          e = toEntry(r);
        } catch {
          return { ok: false, brokenAtSeq: r.seq, reason: 'unparseable data' };
        }
        if (entryHash(e) !== r.hash) return { ok: false, brokenAtSeq: r.seq, reason: 'entry hash mismatch (content modified)' };
        prev = r.hash;
        expectedSeq++;
        n++;
      }
      return { ok: true, entries: n, head: prev };
    },
    list(opts = {}) {
      const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
      const after = opts.afterSeq ?? 0;
      const rows = opts.actionId
        ? (db.prepare('SELECT * FROM audit_log WHERE action_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?').all(opts.actionId, after, limit) as Row[])
        : (db.prepare('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(after, limit) as Row[]);
      return rows.map(toEntry);
    },
    head,
  };
}
