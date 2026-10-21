/**
 * Account data purge on owner revocation.
 *
 * When the owner revokes an account (scripts/connect-account.ts --revoke, or
 * /revoke in Telegram), everything Potts synced from it is deleted: mail items,
 * mail sync cursors and logs. Memory
 * facts sourced from the account (memory source id `account:<id>`) are removed
 * through the memory store's revokeSource(), which writes its own tombstones
 * and receipt. A content-free receipt (ids, counts, hash) is stored in
 * account_purge_receipts and, when a ledger is supplied, audited.
 *
 * Re-connecting later starts a fresh full sync (the cursors are gone).
 */
import type { Clock } from '../../core/clock.ts';
import { hashCanonical } from '../../core/hash.ts';
import { newId } from '../../core/ids.ts';
import { withTransaction, type Db } from '../../store/db.ts';

/** Memory source id under which facts derived from an account must be registered so a revoke can remove them. */
export const accountMemorySourceId = (accountId: string) => `account:${accountId}`;

export interface AccountPurgeCounts {
  mailItems: number;
  mailSyncState: number;
  mailSyncLog: number;
}

export interface AccountPurgeReceipt {
  id: string;
  accountId: string;
  reason: string;
  actor: string;
  at: string;
  counts: AccountPurgeCounts;
  /** Memory deletion receipt (revokeSource) when the account had a memory source. */
  memory: { receiptId: string; facts: number; factVersions: number } | null;
  receiptHash: string;
}

/** Minimal memory surface needed here (MemoryStore satisfies it). */
export interface PurgeMemory {
  getSource(id: string): { id: string } | undefined;
  revokeSource(id: string): { ok: true; value: { id: string; counts: { facts: number; factVersions: number } } } | { ok: false; error: { message: string } };
}

const TABLES: [keyof AccountPurgeCounts, string][] = [
  ['mailItems', 'mail_items'],
  ['mailSyncState', 'mail_sync_state'],
  ['mailSyncLog', 'mail_sync_log'],
];

export interface PurgeOptions {
  db: Db;
  clock: Clock;
  accountId: string;
  actor: string;
  reason?: string;
  memory?: PurgeMemory | null;
  audit?: { append(e: { type: 'account_purge'; actor: string; data: Record<string, unknown> }): unknown };
}

export function purgeAccountData(o: PurgeOptions): AccountPurgeReceipt {
  const { db, clock, accountId } = o;
  const exists = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const counts = Object.fromEntries(TABLES.map(([k]) => [k, 0])) as unknown as AccountPurgeCounts;
  // Overwrite deleted content in the database file instead of only unlinking pages.
  try {
    db.exec('PRAGMA secure_delete = ON');
  } catch {
    /* best effort */
  }
  let memory: AccountPurgeReceipt['memory'] = null;
  const memSource = accountMemorySourceId(accountId);
  if (o.memory?.getSource(memSource)) {
    const r = o.memory.revokeSource(memSource);
    if (r.ok) memory = { receiptId: r.value.id, facts: r.value.counts.facts, factVersions: r.value.counts.factVersions };
  }
  const receipt = withTransaction(db, () => {
    for (const [k, t] of TABLES) {
      if (!exists(t)) continue;
      counts[k] = Number(db.prepare(`DELETE FROM ${t} WHERE account_id = ?`).run(accountId).changes);
    }
    const id = newId('purge', clock);
    const at = clock.nowIso();
    const reason = o.reason ?? 'account revoked by the owner';
    const body = { id, accountId, reason, actor: o.actor, at, counts, memory };
    const receiptHash = hashCanonical(body);
    db.prepare('INSERT INTO account_purge_receipts (id, account_id, reason, actor, counts_json, memory_receipt_id, at, receipt_hash) VALUES (?,?,?,?,?,?,?,?)').run(
      id, accountId, reason, o.actor, JSON.stringify({ counts, memory }), memory?.receiptId ?? null, at, receiptHash,
    );
    o.audit?.append({ type: 'account_purge', actor: o.actor, data: { receiptId: id, accountId, counts, memoryReceiptId: memory?.receiptId ?? null, receiptHash } });
    return { ...body, receiptHash };
  });
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* another connection may hold the WAL; the content is still overwritten on checkpoint */
  }
  return receipt;
}

export function listAccountPurgeReceipts(db: Db, accountId?: string, limit = 50): AccountPurgeReceipt[] {
  const rows = (accountId
    ? db.prepare('SELECT * FROM account_purge_receipts WHERE account_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(accountId, limit)
    : db.prepare('SELECT * FROM account_purge_receipts ORDER BY at DESC, id DESC LIMIT ?').all(limit)) as {
    id: string; account_id: string; reason: string; actor: string; counts_json: string; memory_receipt_id: string | null; at: string; receipt_hash: string;
  }[];
  return rows.map((r) => {
    const c = JSON.parse(r.counts_json) as { counts: AccountPurgeCounts; memory: AccountPurgeReceipt['memory'] };
    return { id: r.id, accountId: r.account_id, reason: r.reason, actor: r.actor, at: r.at, counts: c.counts, memory: c.memory, receiptHash: r.receipt_hash };
  });
}
