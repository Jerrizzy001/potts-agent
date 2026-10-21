import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256Hex } from '../../src/core/index.ts';
import { appleDateToIso, isAutomatedHandle, openChatDb } from '../../src/connectors/imessage/reader.ts';
import { decodeAttributedBody, encodeAttributedBodyForTest, readTsInt } from '../../src/connectors/imessage/reader-typedstream.ts';
import { addMessages, createChatDb, type FixtureMessage } from './chatdb-fixture.ts';

const BASE: FixtureMessage[] = [
  { chat: 'friend', fromMe: true, text: 'yo u coming tonight?' },
  { chat: 'friend', fromMe: false, text: 'OTHER PERSON: never imitate me' },
  { chat: 'friend', fromMe: true, text: 'lol bet 😂', bodyOnly: true },
  { chat: 'group', fromMe: true, text: 'ill bring snacks', bodyOnly: true, mutable: true },
  { chat: 'friend', fromMe: true, text: 'Loved “yo u coming tonight?”', associatedType: 2000 },
  { chat: 'friend', fromMe: true, text: null, itemType: 1 },
  { chat: 'shortcode', fromMe: true, text: 'STOP' },
  { chat: 'alpha', fromMe: true, text: 'YES confirm' },
  { chat: 'friend', fromMe: true, text: 'my code is 482913 dont tell anyone' },
  { chat: 'friend', fromMe: true, text: 'the wifi password is hunter22' },
  { chat: 'friend', fromMe: true, text: 'come to 123 Main Street' },
  { chat: 'work', fromMe: true, text: 'Hi Dana, thank you for reaching out. I am available Tuesday afternoon for the interview.' },
  { chat: 'school', fromMe: true, text: 'Hello Professor, could you clarify the assignment deadline?' },
  { chat: 'friend', fromMe: true, text: 'x'.repeat(0) + 'see you at 7' },
];

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'potts-chatdb-test-'));
  return { dir, path: join(dir, 'chat.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fileHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)) out[f] = sha256Hex(readFileSync(join(dir, f)));
  return out;
}

test('typedstream decoder: NSString / NSMutableString, long strings, emoji, garbage', () => {
  assert.equal(decodeAttributedBody(encodeAttributedBodyForTest('hello')), 'hello');
  assert.equal(decodeAttributedBody(encodeAttributedBodyForTest('mutable 👋🏽 text', { mutable: true })), 'mutable 👋🏽 text');
  const long = 'This is a longer message that exceeds one hundred and twenty seven bytes so the length uses the 0x81 prefix. ' + 'é'.repeat(80);
  assert.equal(decodeAttributedBody(encodeAttributedBodyForTest(long)), long);
  const huge = 'z'.repeat(70000);
  assert.equal(decodeAttributedBody(encodeAttributedBodyForTest(huge)), huge);
  assert.equal(decodeAttributedBody(encodeAttributedBodyForTest('￼ photo caption')), 'photo caption');
  assert.equal(decodeAttributedBody(null), null);
  assert.equal(decodeAttributedBody(new Uint8Array([1, 2, 3])), null);
  assert.equal(decodeAttributedBody(new Uint8Array(200).fill(0x84)), null);
  // Truncated blob: never throws.
  const b = encodeAttributedBodyForTest('cut off message here');
  assert.doesNotThrow(() => decodeAttributedBody(b.subarray(0, 60)));
  // Fallback scan: class name missing but a "+"-typed string present.
  const enc = new TextEncoder();
  const odd = Uint8Array.from([0x04, 0x0b, ...enc.encode('streamtyped'), 0x81, 0xe8, 0x03, 0x84, 0x01, 0x2b, 0x05, ...enc.encode('hey u')]);
  assert.equal(decodeAttributedBody(odd), 'hey u');
  assert.deepEqual(readTsInt(Uint8Array.from([0x81, 0x34, 0x12]), 0), [0x1234, 3]);
  assert.deepEqual(readTsInt(Uint8Array.from([0x82, 1, 0, 1, 0]), 0), [65537, 5]);
  assert.equal(readTsInt(Uint8Array.from([0x90]), 0), null);
});

test('helpers: apple dates and automated handles', () => {
  assert.equal(appleDateToIso(0), null);
  assert.equal(appleDateToIso(Number((BigInt(Date.parse('2026-09-01T12:00:00Z') - 978_307_200_000) * 1_000_000n))), '2026-09-01T12:00:00.000Z');
  assert.equal(appleDateToIso(600_000_000), new Date((600_000_000 + 978_307_200) * 1000).toISOString());
  for (const h of ['72345', '+262966', 'BANKALERT', 'AMZN-OTP', 'urn:biz:abc', 'no-reply@bank.test', 'notifications@site.test']) assert.ok(isAutomatedHandle(h), h);
  for (const h of ['+14165550101', 'friend@example.com', 'chat902341234567', 'recruiter@examplecorp.test']) assert.ok(!isAutomatedHandle(h), h);
});

test('reader returns only owner-authored text items, decodes attributedBody, excludes automated chats and sensitive content', () => {
  const t = tmp();
  try {
    createChatDb(t.path, BASE).close();
    const r = openChatDb({ dbPath: t.path });
    const all = r.readAll(0);
    r.close();
    const texts = all.messages.map((m) => m.text);
    assert.deepEqual(texts, [
      'yo u coming tonight?',
      'lol bet 😂',
      'ill bring snacks',
      'Hi Dana, thank you for reaching out. I am available Tuesday afternoon for the interview.',
      'Hello Professor, could you clarify the assignment deadline?',
      'see you at 7',
    ]);
    assert.ok(!texts.some((x) => x.includes('OTHER PERSON')), 'never returns other participants');
    assert.equal(all.messages[1]!.decodedFrom, 'attributedBody');
    assert.equal(all.messages[2]!.chatKind, 'group');
    assert.equal(all.messages[2]!.participantCount, 2);
    assert.equal(all.messages[3]!.recipientKind, 'email_work');
    assert.equal(all.messages[0]!.recipientKind, 'phone');
    assert.equal(all.messages[0]!.sentAt, '2026-09-01T12:00:00.000Z');
    assert.match(all.messages[0]!.guidHash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(all.messages).includes('+14165550101'), 'handles are not exposed');
    assert.equal(all.excluded.not_text_item, 2);
    assert.equal(all.excluded.automated_chat, 2);
    assert.equal(all.excluded['sensitive:otp_code'], 1);
    assert.equal(all.excluded['sensitive:credential'], 1);
    assert.equal(all.excluded['sensitive:street_address'], 1);
    assert.equal(all.scanned, 13, 'other participants are not even scanned');
    assert.equal(all.done, true);
  } finally {
    t.cleanup();
  }
});

test('incremental cursor by ROWID; WAL content visible in copy mode; source files never modified; temp copy removed', () => {
  const t = tmp();
  const tempRoot = mkdtempSync(join(tmpdir(), 'potts-reader-tmp-'));
  try {
    const writer = createChatDb(t.path, BASE.slice(0, 4), { wal: true });
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    addMessages(writer, [{ chat: 'friend', fromMe: true, text: 'only in the wal so far' }]); // not checkpointed; writer stays open
    const before = fileHashes(t.dir);
    const r1 = openChatDb({ dbPath: t.path, tempRoot });
    const b1 = r1.readBatch(0, 2);
    assert.equal(b1.messages.length, 2);
    assert.equal(b1.done, false);
    const b2 = r1.readBatch(b1.lastRowid, 100);
    assert.deepEqual(b2.messages.map((m) => m.text), ['ill bring snacks', 'only in the wal so far']);
    assert.ok(b2.lastRowid > b1.lastRowid);
    const cursor = b2.lastRowid;
    assert.equal(r1.maxRowid(), cursor);
    assert.equal(readdirSync(tempRoot).length, 1, 'private temp copy exists while open');
    r1.close();
    assert.equal(readdirSync(tempRoot).length, 0, 'temp copy deleted on close');

    // Immutable mode: no locks/-shm writes, but cannot see un-checkpointed WAL frames.
    const ri = openChatDb({ dbPath: t.path, mode: 'immutable' });
    assert.ok(!ri.readAll(0).messages.some((m) => m.text === 'only in the wal so far'));
    ri.close();
    assert.deepEqual(fileHashes(t.dir), before, 'reader must not modify chat.db, -wal or -shm');

    addMessages(writer, [
      { chat: 'friend', fromMe: true, text: 'new one after cursor' },
      { chat: 'friend', fromMe: false, text: 'reply from them' },
    ]);
    const r2 = openChatDb({ dbPath: t.path, tempRoot });
    const b3 = r2.readAll(cursor);
    r2.close();
    assert.deepEqual(b3.messages.map((m) => m.text), ['new one after cursor']);
    writer.close();
  } finally {
    t.cleanup();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('reader refuses missing files and unexpected schemas', () => {
  const t = tmp();
  try {
    assert.throws(() => openChatDb({ dbPath: join(t.dir, 'nope.db') }), /not found/);
    createChatDb(t.path, []).close();
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const bad = join(t.dir, 'bad.db');
    const d = new DatabaseSync(bad);
    d.exec('CREATE TABLE message (ROWID INTEGER PRIMARY KEY, foo TEXT); CREATE TABLE chat (ROWID INTEGER PRIMARY KEY); CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT); CREATE TABLE chat_message_join (chat_id INT, message_id INT);');
    d.close();
    assert.throws(() => openChatDb({ dbPath: bad }), /unexpected schema/);
  } finally {
    t.cleanup();
  }
});

test('reader modules contain no sending or writing code paths', () => {
  const dir = join(import.meta.dirname, '../../src/connectors/imessage');
  for (const f of readdirSync(dir).filter((x) => x.startsWith('reader'))) {
    const src = readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    assert.ok(!/osascript|child_process|AppleScript|\bspawn\b|\bexecFile|\bexecSync|\bfetch\(/.test(src), `${f} must not run external programs`);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE)\s/i.test(src.replace(/PRAGMA\s+\w+/g, '')), `${f} must not contain write SQL`);
    assert.ok(!/\bsend\w*\s*\(/i.test(src), `${f} must not contain send functions`);
    assert.ok(!/writer/i.test(src.replace(/no writer here; WP-7 owns writer\*/i, '')), `${f} must not import writers`);
  }
});
