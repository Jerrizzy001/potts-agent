import type { Clock } from '../../core/clock.ts';
import { hashCanonical } from '../../core/hash.ts';
import { newId } from '../../core/ids.ts';
import { withTransaction, type Db } from '../../store/db.ts';
import { classifyMail, type ClassifierOptions, type MailCategory, type MailClassification, type MailPriority } from './classify.ts';
import type { MailAddress, MailAttachmentMeta, NormalizedMail } from './types.ts';

export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged';

export interface StoredMail extends NormalizedMail {
  contentHash: string;
  category: MailCategory;
  priority: MailPriority;
  classification: MailClassification;
  injectionFlagged: boolean;
  firstSeenAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type MailSyncStatus = 'never' | 'ok' | 'stale_auth' | 'admin_consent_required' | 'rate_limited' | 'error' | 'revoked' | 'paused';
export interface MailSyncState {
  accountId: string;
  provider: 'gmail' | 'outlook';
  cursor: string | null;
  lastFullSyncAt: string | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  status: MailSyncStatus;
  statusReason: string | null;
}

export interface SyncLogEntry {
  accountId: string;
  startedAt: string;
  mode: 'full' | 'incremental' | 'full_after_expiry';
  outcome: string;
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
  detail?: string;
}

export interface MailListOptions {
  accountId?: string;
  priority?: MailPriority;
  category?: MailCategory;
  sinceIso?: string;
  includeDeleted?: boolean;
  limit?: number;
}

/**
 * Shared mail item store. Upserts are idempotent and keyed by
 * (account, provider message id): re-syncing the same message never creates a
 * duplicate, and an unchanged message is not rewritten.
 */
export interface MailStore {
  upsert(m: NormalizedMail, classification?: MailClassification): UpsertOutcome;
  markDeleted(accountId: string, providerMessageId: string): boolean;
  get(accountId: string, providerMessageId: string): StoredMail | undefined;
  list(o?: MailListOptions): StoredMail[];
  count(accountId?: string): number;
  getSyncState(accountId: string): MailSyncState | undefined;
  setSyncState(s: MailSyncState): void;
  logSync(e: SyncLogEntry): void;
  recentSyncLog(accountId: string, limit?: number): (SyncLogEntry & { finishedAt: string })[];
  readonly db: Db;
  readonly clock: Clock;
  /** Classifier options used for upserts without an explicit classification; readers reuse them. */
  readonly classifierOptions: ClassifierOptions;
}

type Row = Record<string, string | number | null>;

const contentHashOf = (m: NormalizedMail) => hashCanonical({ ...m });

function toStored(r: Row): StoredMail {
  const j = <T>(k: string) => JSON.parse(String(r[k])) as T;
  return {
    accountId: String(r.account_id), provider: r.provider as 'gmail' | 'outlook', providerMessageId: String(r.provider_message_id),
    threadId: (r.thread_id as string) ?? null, internetMessageId: (r.internet_message_id as string) ?? null,
    from: r.from_address ? { address: String(r.from_address), name: (r.from_name as string) ?? null } : null,
    to: j<MailAddress[]>('to_json'), cc: j<MailAddress[]>('cc_json'), replyTo: j<{ replyTo?: MailAddress[] }>('classification_json').replyTo ?? [],
    subject: String(r.subject ?? ''), snippet: String(r.snippet ?? ''), bodyText: String(r.body_text ?? ''),
    bodySource: (r.body_source as 'text' | 'html' | 'none') ?? 'none', receivedAt: (r.received_at as string) ?? null,
    contentFlags: j<{ contentFlags?: string[] }>('classification_json').contentFlags ?? [],
    labels: j<string[]>('labels_json'), headers: j<Record<string, string>>('headers_json'), attachments: j<MailAttachmentMeta[]>('attachments_json'),
    contentHash: String(r.content_hash), category: r.category as MailCategory, priority: r.priority as MailPriority,
    classification: j<{ c: MailClassification }>('classification_json').c, injectionFlagged: r.injection_flagged === 1,
    firstSeenAt: String(r.first_seen_at), updatedAt: String(r.updated_at), deletedAt: (r.deleted_at as string) ?? null,
  };
}

export function createMailStore(db: Db, clock: Clock, classifierOptions: ClassifierOptions = {}): MailStore {
  const get = (a: string, id: string) => {
    const r = db.prepare('SELECT * FROM mail_items WHERE account_id = ? AND provider_message_id = ?').get(a, id) as Row | undefined;
    return r ? toStored(r) : undefined;
  };
  return {
    db,
    clock,
    classifierOptions,
    upsert(m, cls) {
      const hash = contentHashOf(m);
      return withTransaction(db, () => {
        const prev = db.prepare('SELECT content_hash, deleted_at FROM mail_items WHERE account_id = ? AND provider_message_id = ?').get(m.accountId, m.providerMessageId) as
          | { content_hash: string; deleted_at: string | null }
          | undefined;
        if (prev && prev.content_hash === hash && prev.deleted_at === null) return 'unchanged';
        const c = cls ?? classifyMail(m, classifierOptions);
        const now = clock.nowIso();
        const vals = [
          m.provider, m.threadId, m.internetMessageId, m.from?.address ?? null, m.from?.name ?? null, JSON.stringify(m.to), JSON.stringify(m.cc),
          m.subject, m.snippet, m.bodyText, m.bodySource, m.receivedAt, JSON.stringify(m.labels), JSON.stringify(m.headers), JSON.stringify(m.attachments),
          hash, c.category, c.priority, JSON.stringify({ c, replyTo: m.replyTo, contentFlags: m.contentFlags }), c.injection.flagged ? 1 : 0,
        ] as const;
        if (!prev) {
          db.prepare(
            `INSERT INTO mail_items (account_id, provider_message_id, provider, thread_id, internet_message_id, from_address, from_name, to_json, cc_json,
              subject, snippet, body_text, body_source, received_at, labels_json, headers_json, attachments_json, content_hash, category, priority,
              classification_json, injection_flagged, first_seen_at, updated_at, deleted_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
          ).run(m.accountId, m.providerMessageId, ...vals, now, now);
          return 'inserted';
        }
        db.prepare(
          `UPDATE mail_items SET provider=?, thread_id=?, internet_message_id=?, from_address=?, from_name=?, to_json=?, cc_json=?, subject=?, snippet=?,
             body_text=?, body_source=?, received_at=?, labels_json=?, headers_json=?, attachments_json=?, content_hash=?, category=?, priority=?,
             classification_json=?, injection_flagged=?, updated_at=?, deleted_at=NULL
           WHERE account_id=? AND provider_message_id=?`,
        ).run(...vals, now, m.accountId, m.providerMessageId);
        return 'updated';
      });
    },
    markDeleted(a, id) {
      const r = db.prepare('UPDATE mail_items SET deleted_at = ?, updated_at = ? WHERE account_id = ? AND provider_message_id = ? AND deleted_at IS NULL').run(clock.nowIso(), clock.nowIso(), a, id);
      return Number(r.changes) > 0;
    },
    get,
    list(o = {}) {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (o.accountId) (where.push('account_id = ?'), args.push(o.accountId));
      if (o.priority) (where.push('priority = ?'), args.push(o.priority));
      if (o.category) (where.push('category = ?'), args.push(o.category));
      if (o.sinceIso) (where.push('received_at >= ?'), args.push(o.sinceIso));
      if (!o.includeDeleted) where.push('deleted_at IS NULL');
      const sql = `SELECT * FROM mail_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY received_at DESC, provider_message_id LIMIT ?`;
      return (db.prepare(sql).all(...args, o.limit ?? 200) as Row[]).map(toStored);
    },
    count(accountId) {
      const r = (accountId
        ? db.prepare('SELECT COUNT(*) AS n FROM mail_items WHERE account_id = ?').get(accountId)
        : db.prepare('SELECT COUNT(*) AS n FROM mail_items').get()) as { n: number };
      return Number(r.n);
    },
    getSyncState(a) {
      const r = db.prepare('SELECT * FROM mail_sync_state WHERE account_id = ?').get(a) as Row | undefined;
      if (!r) return undefined;
      return {
        accountId: String(r.account_id), provider: r.provider as 'gmail' | 'outlook', cursor: (r.cursor as string) ?? null,
        lastFullSyncAt: (r.last_full_sync_at as string) ?? null, lastSyncAt: (r.last_sync_at as string) ?? null,
        lastSuccessAt: (r.last_success_at as string) ?? null, status: r.status as MailSyncStatus, statusReason: (r.status_reason as string) ?? null,
      };
    },
    setSyncState(s) {
      db.prepare(
        `INSERT INTO mail_sync_state (account_id, provider, cursor, last_full_sync_at, last_sync_at, last_success_at, status, status_reason, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(account_id) DO UPDATE SET provider=excluded.provider, cursor=excluded.cursor, last_full_sync_at=excluded.last_full_sync_at,
           last_sync_at=excluded.last_sync_at, last_success_at=excluded.last_success_at, status=excluded.status, status_reason=excluded.status_reason,
           updated_at=excluded.updated_at`,
      ).run(s.accountId, s.provider, s.cursor, s.lastFullSyncAt, s.lastSyncAt, s.lastSuccessAt, s.status, s.statusReason, clock.nowIso());
    },
    logSync(e) {
      db.prepare(
        'INSERT INTO mail_sync_log (id, account_id, started_at, finished_at, mode, outcome, inserted, updated, unchanged, deleted, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).run(newId('msl', clock), e.accountId, e.startedAt, clock.nowIso(), e.mode, e.outcome, e.inserted, e.updated, e.unchanged, e.deleted, e.detail ?? null);
    },
    recentSyncLog(a, limit = 20) {
      return (db.prepare('SELECT * FROM mail_sync_log WHERE account_id = ? ORDER BY rowid DESC LIMIT ?').all(a, limit) as Row[]).map((r) => ({
        accountId: String(r.account_id), startedAt: String(r.started_at), finishedAt: String(r.finished_at), mode: r.mode as SyncLogEntry['mode'],
        outcome: String(r.outcome), inserted: Number(r.inserted), updated: Number(r.updated), unchanged: Number(r.unchanged), deleted: Number(r.deleted),
        ...(r.detail ? { detail: String(r.detail) } : {}),
      }));
    },
  };
}
