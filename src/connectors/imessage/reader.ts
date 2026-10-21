/**
 * Read-only reader for the local Messages database (~/Library/Messages/chat.db).
 *
 * Guarantees:
 * - Never writes to chat.db. Default mode copies chat.db (+ -wal/-shm) into a
 *   private 0700 temp dir, opens the copy with readOnly + query_only, and
 *   deletes the copy on close. 'immutable' mode opens the original through a
 *   file: URI with immutable=1 + readOnly (no locks, no -shm writes) but does
 *   not see messages still in the WAL.
 * - Yields only owner-authored rows (is_from_me = 1) that are plain text
 *   items (no tapbacks/reactions/system items).
 * - Excludes automated/short-code chats and anything detectSensitive() flags
 *   (credentials, one-time codes, tokenised URLs, cards, ids, bank details,
 *   street addresses). Excluded rows are counted, never returned.
 * - Contains no sending capability of any kind.
 *
 * Reading the real file needs Full Disk Access for the process's binary
 * (see the WP-3 owner steps). Tests use a synthetic fixture only.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '../../core/index.ts';
import { detectSensitive, type SensitiveReason } from '../../memory/sensitive.ts';
import { decodeAttributedBody } from './reader-typedstream.ts';

export type ChatKind = 'individual' | 'group' | 'unknown';
export type RecipientKind = 'phone' | 'email_personal' | 'email_work' | 'mixed' | 'unknown';

export interface OwnerMessage {
  rowid: number;
  /** sha256 of the message guid; the guid itself is not exposed. */
  guidHash: string;
  sentAt: string | null;
  text: string;
  service: string | null;
  chatKind: ChatKind;
  recipientKind: RecipientKind;
  participantCount: number;
  /** sha256 of the chat identifier (stable grouping without exposing the handle). */
  chatHash: string | null;
  decodedFrom: 'text' | 'attributedBody';
}

export type ExclusionReason = 'empty' | 'not_text_item' | 'automated_chat' | 'decode_failed' | `sensitive:${SensitiveReason}`;

export interface ReadBatch {
  messages: OwnerMessage[];
  /** Highest ROWID examined (kept or excluded); persist this as the cursor. */
  lastRowid: number;
  scanned: number;
  excluded: Partial<Record<ExclusionReason, number>>;
  done: boolean;
}

export interface ChatDbReader {
  readonly mode: 'copy' | 'immutable';
  readBatch(afterRowid: number, limit?: number): ReadBatch;
  readAll(afterRowid: number, opts?: { batchSize?: number; maxRows?: number }): ReadBatch;
  maxRowid(): number;
  close(): void;
}

export interface OpenChatDbOptions {
  dbPath: string;
  mode?: 'copy' | 'immutable';
  /** Where the private temp copy is made (default os.tmpdir()). */
  tempRoot?: string;
  /** Extra domains treated as personal email providers. */
  personalEmailDomains?: string[];
}

export const DEFAULT_CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db');
const APPLE_EPOCH_S = 978_307_200;
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'icloud.com', 'me.com', 'mac.com', 'hotmail.com', 'hotmail.ca', 'outlook.com', 'live.com', 'live.ca', 'msn.com',
  'yahoo.com', 'yahoo.ca', 'ymail.com', 'proton.me', 'protonmail.com', 'aol.com', 'gmx.com', 'hey.com', 'fastmail.com', 'rogers.com', 'bell.net', 'sympatico.ca',
]);

/**
 * Converts Messages' `date` (seconds or nanoseconds since 2001-01-01) to ISO.
 * Modern values are nanoseconds (~8e17, beyond Number precision), so the SQL
 * converts them to float seconds before they reach JavaScript.
 */
export function appleDateToIso(v: number | bigint | null): string | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const secs = n > 1e11 ? n / 1e9 : n;
  const ms = Math.round((secs + APPLE_EPOCH_S) * 1000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Short codes, alphanumeric sender ids, business chat, no-reply style addresses. */
export function isAutomatedHandle(id: string | null | undefined): boolean {
  if (!id) return false;
  const h = id.trim();
  if (/^chat\d+$/i.test(h)) return false; // group chat identifier, not a sender
  if (/^urn:biz:/i.test(h)) return true;
  if (/^\+?\d{3,6}$/.test(h)) return true; // SMS short code
  if (/@/.test(h)) {
    return /^(no-?reply|do-?not-?reply|donotreply|notifications?|alerts?|mailer-daemon|info|support|service|updates|news|bounce)[@+._-]/i.test(h);
  }
  // Alphanumeric sender id ("Rogers", "GOOGLE", "AMZN-OTP"): no phone digits, not an email.
  if (/^[A-Za-z][A-Za-z0-9 ._&-]{1,15}$/.test(h) && !/^\+?\d/.test(h)) return true;
  return false;
}

function recipientKindOf(handles: string[], personal: Set<string>): RecipientKind {
  if (handles.length === 0) return 'unknown';
  const kinds = new Set<RecipientKind>();
  for (const h of handles) {
    const at = h.lastIndexOf('@');
    if (at > 0) kinds.add(personal.has(h.slice(at + 1).toLowerCase()) ? 'email_personal' : 'email_work');
    else kinds.add('phone');
  }
  return kinds.size === 1 ? [...kinds][0]! : 'mixed';
}

interface ChatInfo {
  kind: ChatKind;
  handles: string[];
  identifier: string | null;
  automated: boolean;
}

export function openReadOnly(path: string, mode: 'copy' | 'immutable', tempRoot?: string): { db: DatabaseSync; cleanup: () => void } {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`chat database not found: ${abs}`);
  if (mode === 'immutable') {
    const db = new DatabaseSync(`file:${encodeURI(abs).replace(/\?/g, '%3F').replace(/#/g, '%23')}?mode=ro&immutable=1`, { readOnly: true });
    db.exec('PRAGMA query_only = ON;');
    return { db, cleanup: () => db.close() };
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const dir = mkdtempSync(join(tempRoot ?? tmpdir(), 'potts-chatdb-'));
    const cleanupDir = () => rmSync(dir, { recursive: true, force: true });
    try {
      const target = join(dir, 'chat.db');
      // Copy the WAL first, then the main file, then the shm, so a checkpoint in
      // between can only move data into the main file we copy afterwards.
      if (existsSync(abs + '-wal')) copyFileSync(abs + '-wal', target + '-wal');
      copyFileSync(abs, target);
      if (existsSync(abs + '-shm')) copyFileSync(abs + '-shm', target + '-shm');
      const db = new DatabaseSync(target, { readOnly: true });
      db.exec('PRAGMA query_only = ON;');
      const check = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
      if (check?.quick_check !== 'ok') {
        db.close();
        throw new Error('copied chat database failed quick_check');
      }
      return {
        db,
        cleanup: () => {
          try {
            db.close();
          } finally {
            cleanupDir();
          }
        },
      };
    } catch (e) {
      lastErr = e;
      cleanupDir();
    }
  }
  throw new Error(`could not take a consistent copy of the chat database: ${(lastErr as Error)?.message ?? 'unknown error'}`);
}

export function openChatDb(o: OpenChatDbOptions): ChatDbReader {
  const mode = o.mode ?? 'copy';
  const { db, cleanup } = openReadOnly(o.dbPath, mode, o.tempRoot);
  const personal = new Set([...PERSONAL_EMAIL_DOMAINS, ...(o.personalEmailDomains ?? []).map((d) => d.toLowerCase())]);
  const cols = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));
  const mcols = cols('message');
  for (const req of ['ROWID', 'guid', 'text', 'is_from_me', 'date', 'handle_id']) {
    if (!mcols.has(req)) {
      cleanup();
      throw new Error(`chat database has an unexpected schema (message.${req} missing)`);
    }
  }
  const ccols = cols('chat');
  const opt = (c: string, fallback: string) => (mcols.has(c) ? `m.${c}` : fallback);
  const stmt = db.prepare(
    `SELECT m.ROWID AS rowid, m.guid AS guid, m.text AS text, ${opt('attributedBody', 'NULL')} AS body, CASE WHEN m.date > 100000000000 THEN m.date / 1000000000.0 ELSE m.date END AS date,
            ${opt('service', 'NULL')} AS service, ${opt('associated_message_type', '0')} AS amt, ${opt('item_type', '0')} AS item_type,
            m.handle_id AS handle_id,
            (SELECT cmj.chat_id FROM chat_message_join cmj WHERE cmj.message_id = m.ROWID ORDER BY cmj.chat_id LIMIT 1) AS chat_id
       FROM message m WHERE m.is_from_me = 1 AND m.ROWID > ? ORDER BY m.ROWID LIMIT ?`,
  );
  const chatStmt = db.prepare(`SELECT ROWID AS id, chat_identifier AS ident, ${ccols.has('style') ? 'style' : 'NULL'} AS style FROM chat WHERE ROWID = ?`);
  const hasChj = (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_handle_join'").get() as unknown) !== undefined;
  const chatHandles = hasChj ? db.prepare('SELECT h.id AS id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = ?') : null;
  const handleStmt = db.prepare('SELECT id FROM handle WHERE ROWID = ?');
  const chatCache = new Map<number, ChatInfo>();

  function chatInfo(chatId: number | null, handleId: number | null): ChatInfo {
    if (chatId !== null && chatCache.has(chatId)) return chatCache.get(chatId)!;
    let info: ChatInfo = { kind: 'unknown', handles: [], identifier: null, automated: false };
    if (chatId !== null) {
      const c = chatStmt.get(chatId) as { id: number; ident: string | null; style: number | null } | undefined;
      const handles = chatHandles ? (chatHandles.all(chatId) as { id: string }[]).map((r) => r.id) : [];
      if (c) {
        const kind: ChatKind = c.style === 43 ? 'group' : c.style === 45 ? 'individual' : handles.length > 1 ? 'group' : handles.length === 1 ? 'individual' : 'unknown';
        info = { kind, handles, identifier: c.ident, automated: isAutomatedHandle(c.ident) || handles.some(isAutomatedHandle) };
      }
      chatCache.set(chatId, info);
    }
    if (info.handles.length === 0 && handleId) {
      const h = handleStmt.get(handleId) as { id: string } | undefined;
      if (h) info = { ...info, handles: [h.id], kind: info.kind === 'unknown' ? 'individual' : info.kind, automated: info.automated || isAutomatedHandle(h.id) };
    }
    return info;
  }

  function readBatch(afterRowid: number, limit = 500): ReadBatch {
    const rows = stmt.all(afterRowid, Math.min(Math.max(limit, 1), 5000)) as {
      rowid: number;
      guid: string;
      text: string | null;
      body: Uint8Array | null;
      date: number | bigint | null;
      service: string | null;
      amt: number | null;
      item_type: number | null;
      handle_id: number | null;
      chat_id: number | null;
    }[];
    const out: ReadBatch = { messages: [], lastRowid: afterRowid, scanned: rows.length, excluded: {}, done: rows.length < limit };
    const exclude = (r: ExclusionReason) => (out.excluded[r] = (out.excluded[r] ?? 0) + 1);
    for (const r of rows) {
      out.lastRowid = Math.max(out.lastRowid, Number(r.rowid));
      if ((r.amt ?? 0) !== 0 || (r.item_type ?? 0) !== 0) {
        exclude('not_text_item');
        continue;
      }
      let text = (r.text ?? '').replace(/[￼�]/g, '').trim();
      let decodedFrom: OwnerMessage['decodedFrom'] = 'text';
      if (!text && r.body) {
        const d = decodeAttributedBody(r.body);
        if (d === null) {
          exclude('decode_failed');
          continue;
        }
        text = d;
        decodedFrom = 'attributedBody';
      }
      if (!text) {
        exclude('empty');
        continue;
      }
      const chat = chatInfo(r.chat_id, r.handle_id);
      if (chat.automated) {
        exclude('automated_chat');
        continue;
      }
      const verdict = detectSensitive(text);
      if (verdict.sensitive) {
        exclude(`sensitive:${verdict.reasons[0]!}`);
        continue;
      }
      out.messages.push({
        rowid: Number(r.rowid),
        guidHash: sha256Hex(String(r.guid ?? r.rowid)),
        sentAt: appleDateToIso(r.date),
        text,
        service: r.service,
        chatKind: chat.kind,
        recipientKind: recipientKindOf(chat.handles, personal),
        participantCount: chat.handles.length,
        chatHash: chat.identifier ? sha256Hex(chat.identifier) : null,
        decodedFrom,
      });
    }
    return out;
  }

  return {
    mode,
    readBatch,
    readAll(afterRowid, { batchSize = 1000, maxRows = Number.MAX_SAFE_INTEGER } = {}) {
      const total: ReadBatch = { messages: [], lastRowid: afterRowid, scanned: 0, excluded: {}, done: false };
      let cursor = afterRowid;
      while (total.scanned < maxRows) {
        const b = readBatch(cursor, Math.min(batchSize, maxRows - total.scanned));
        total.messages.push(...b.messages);
        total.scanned += b.scanned;
        total.lastRowid = b.lastRowid;
        for (const [k, v] of Object.entries(b.excluded)) total.excluded[k as ExclusionReason] = (total.excluded[k as ExclusionReason] ?? 0) + (v ?? 0);
        cursor = b.lastRowid;
        if (b.done) {
          total.done = true;
          break;
        }
      }
      return total;
    },
    maxRowid() {
      return Number((db.prepare('SELECT COALESCE(MAX(ROWID), 0) AS m FROM message').get() as { m: number }).m);
    },
    close: cleanup,
  };
}
