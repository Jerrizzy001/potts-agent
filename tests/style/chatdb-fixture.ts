import { DatabaseSync } from 'node:sqlite';
import { encodeAttributedBodyForTest } from '../../src/connectors/imessage/reader-typedstream.ts';

/**
 * Builds a synthetic Messages database with the real schema subset the reader
 * uses (message, handle, chat, chat_message_join, chat_handle_join). No real
 * data: every handle and message here is invented.
 */
export const CHAT_SCHEMA = `
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT, UNIQUE (id, service));
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT, properties BLOB, chat_identifier TEXT, service_name TEXT, room_name TEXT, account_login TEXT, is_archived INTEGER DEFAULT 0, last_addressed_handle TEXT, display_name TEXT, group_id TEXT, is_filtered INTEGER DEFAULT 0, successful_query INTEGER);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, replace INTEGER DEFAULT 0, service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT, country TEXT, attributedBody BLOB, version INTEGER DEFAULT 0, type INTEGER DEFAULT 0, service TEXT, account TEXT, account_guid TEXT, error INTEGER DEFAULT 0, date INTEGER, date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 0, is_emote INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, is_empty INTEGER DEFAULT 0, is_delayed INTEGER DEFAULT 0, is_auto_reply INTEGER DEFAULT 0, is_prepared INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0, is_sent INTEGER DEFAULT 0, has_dd_results INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, cache_roomnames TEXT, item_type INTEGER DEFAULT 0, other_handle INTEGER DEFAULT 0, group_title TEXT, group_action_type INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0, thread_originator_guid TEXT);
CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
CREATE TABLE chat_handle_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE, UNIQUE(chat_id, handle_id));
`;

export interface FixtureMessage {
  chat: 'friend' | 'group' | 'work' | 'shortcode' | 'alpha' | 'school';
  fromMe: boolean;
  text?: string | null;
  /** Store the text only in attributedBody (text column NULL), like modern macOS. */
  bodyOnly?: boolean;
  mutable?: boolean;
  rawBody?: Uint8Array;
  associatedType?: number;
  itemType?: number;
  /** ISO date; stored as ns since 2001. */
  at?: string;
}

const CHATS = {
  friend: { ident: '+14165550101', style: 45, handles: ['+14165550101'] },
  group: { ident: 'chat902341234567', style: 43, handles: ['+14165550102', '+14165550103'] },
  work: { ident: 'recruiter@examplecorp.test', style: 45, handles: ['recruiter@examplecorp.test'] },
  school: { ident: 'prof.lee@college.test', style: 45, handles: ['prof.lee@college.test'] },
  shortcode: { ident: '72345', style: 45, handles: ['72345'] },
  alpha: { ident: 'BANKALERT', style: 45, handles: ['BANKALERT'] },
} as const;

export function toAppleNs(iso: string): bigint {
  return BigInt(Date.parse(iso) - 978_307_200_000) * 1_000_000n;
}

export function createChatDb(path: string, messages: FixtureMessage[], opts: { wal?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(path);
  if (opts.wal) db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  db.exec(CHAT_SCHEMA);
  const chatIds = new Map<string, number>();
  const handleIds = new Map<string, number>();
  for (const [name, c] of Object.entries(CHATS)) {
    const r = db.prepare('INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES (?, ?, ?, ?)').run(`iMessage;-;${c.ident}`, c.style, c.ident, 'iMessage');
    const cid = Number(r.lastInsertRowid);
    chatIds.set(name, cid);
    for (const h of c.handles) {
      let hid = handleIds.get(h);
      if (!hid) {
        hid = Number(db.prepare('INSERT INTO handle (id, service) VALUES (?, ?)').run(h, 'iMessage').lastInsertRowid);
        handleIds.set(h, hid);
      }
      db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(cid, hid);
    }
  }
  addMessages(db, messages, chatIds, handleIds);
  return db;
}

let guidSeq = 0;
export function addMessages(db: DatabaseSync, messages: FixtureMessage[], chatIds?: Map<string, number>, handleIds?: Map<string, number>): void {
  const cids = chatIds ?? new Map((db.prepare('SELECT ROWID AS id, chat_identifier AS ident FROM chat').all() as { id: number; ident: string }[]).map((r) => [Object.entries(CHATS).find(([, c]) => c.ident === r.ident)![0], r.id]));
  const hids = handleIds ?? new Map((db.prepare('SELECT ROWID AS id, id AS h FROM handle').all() as { id: number; h: string }[]).map((r) => [r.h, r.id]));
  const ins = db.prepare(
    'INSERT INTO message (guid, text, attributedBody, handle_id, service, date, is_from_me, associated_message_type, item_type) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  for (const m of messages) {
    const c = CHATS[m.chat];
    const body = m.rawBody ?? (m.text ? encodeAttributedBodyForTest(m.text, { mutable: !!m.mutable }) : null);
    const r = ins.run(
      `fixture-guid-${++guidSeq}`,
      m.bodyOnly ? null : (m.text ?? null),
      body,
      m.fromMe ? 0 : hids.get(c.handles[0]!)!,
      'iMessage',
      toAppleNs(m.at ?? '2026-09-01T12:00:00.000Z'),
      m.fromMe ? 1 : 0,
      m.associatedType ?? 0,
      m.itemType ?? 0,
    );
    db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(cids.get(m.chat)!, Number(r.lastInsertRowid));
  }
}
