import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFakeClock, newId, canonicalJson, hashCanonical, sha256Hex, hexEqual, redact, createLogger, REDACTED,
  validateConfig, loadConfig, validateSchema, resolveSecretRef, isSecretRef, createAccountRegistry,
} from '../../src/core/index.ts';

test('fake clock is deterministic and advanceable', () => {
  const c = createFakeClock('2026-11-01T05:30:00Z');
  assert.equal(c.nowIso(), '2026-11-01T05:30:00.000Z');
  c.advanceSeconds(3600);
  assert.equal(c.nowIso(), '2026-11-01T06:30:00.000Z');
  c.set('2026-03-08T07:00:00Z');
  assert.equal(c.nowMs(), Date.parse('2026-03-08T07:00:00Z'));
});

test('ids are unique, prefixed and time-sortable', () => {
  const c = createFakeClock('2026-10-06T00:00:00Z');
  const a = newId('act', c);
  c.advanceMs(1);
  const b = newId('act', c);
  assert.match(a, /^act_[0-9A-Z]{26}$/);
  assert.ok(a < b);
  assert.notEqual(newId(), newId());
});

test('canonical JSON sorts keys, omits undefined, rejects non-JSON', () => {
  assert.equal(canonicalJson({ b: 1, a: [3, { d: 1, c: undefined }] }), '{"a":[3,{"d":1}],"b":1}');
  assert.equal(hashCanonical({ x: 1, y: 2 }), hashCanonical({ y: 2, x: 1 }));
  assert.notEqual(hashCanonical({ x: 1 }), hashCanonical({ x: '1' }));
  assert.throws(() => canonicalJson({ n: NaN }));
  assert.throws(() => canonicalJson({ n: 1n }));
  const cyc: Record<string, unknown> = {};
  cyc.self = cyc;
  assert.throws(() => canonicalJson(cyc));
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.ok(hexEqual('ab', 'AB'.toLowerCase()));
  assert.ok(!hexEqual('ab', 'abcd'));
  assert.ok(!hexEqual('zz', 'zz'));
});

test('logger redacts secret-looking keys and token-shaped values but keeps secret refs', () => {
  const lines: string[] = [];
  const log = createLogger({ clock: createFakeClock(), sink: (l) => lines.push(l) });
  log.info('hello', {
    botToken: '123456:abcdef', password: 'hunter2', apiKey: 'x', nested: { cookie: 'c', fine: 'ok' }, ref: 'keychain:potts/x',
    oauthToken: 'keychain:potts/gmail', note: 'Authorization: Bearer abcdefghijklmnop', tg: 'tok 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    secretRefs: { refresh: 'env:GMAIL_REFRESH' },
  });
  const rec = JSON.parse(lines[0]!);
  assert.equal(rec.botToken, REDACTED);
  assert.equal(rec.password, REDACTED);
  assert.equal(rec.apiKey, REDACTED);
  assert.equal(rec.nested.cookie, REDACTED);
  assert.equal(rec.nested.fine, 'ok');
  assert.equal(rec.oauthToken, 'keychain:potts/gmail');
  assert.equal(rec.secretRefs.refresh, 'env:GMAIL_REFRESH');
  assert.ok(!rec.note.includes('abcdefghijklmnop'));
  assert.ok(!rec.tg.includes('AAAAAAAA'));
  assert.equal(redact({ a: [{ secret: 's' }] }) instanceof Object, true);
});

test('example config + accounts validate', () => {
  const r = loadConfig(join(import.meta.dirname, '../../config/potts.example.json'));
  // accountsFile in the example points at accounts.json; validate with the example accounts explicitly.
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, '../../config/potts.example.json'), 'utf8'));
  const acc = JSON.parse(readFileSync(join(import.meta.dirname, '../../config/accounts.example.json'), 'utf8'));
  const v = validateConfig(raw, acc);
  assert.ok(v.ok, v.ok ? '' : v.error.message);
  assert.equal(v.ok && v.value.accounts.length, 5);
  assert.equal(r.ok, false, 'accounts.json does not exist in repo');
  const reg = createAccountRegistry(v.ok ? v.value.accounts : []);
  assert.equal(reg.get('outlook-personal')?.mode, 'not_connected');
});

test('loadConfig resolves accountsFile relative to the config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'potts-cfg-'));
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, '../../config/potts.example.json'), 'utf8'));
  writeFileSync(join(dir, 'potts.json'), JSON.stringify(raw));
  writeFileSync(join(dir, 'accounts.json'), readFileSync(join(import.meta.dirname, '../../config/accounts.example.json')));
  const r = loadConfig(join(dir, 'potts.json'));
  assert.ok(r.ok, r.ok ? '' : r.error.message);
});

test('config validation rejects raw secrets, bad modes, unknown fields, bad timezone, duplicates', () => {
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, '../../config/potts.example.json'), 'utf8'));
  delete raw.accountsFile;
  const acct = { id: 'g1', kind: 'gmail', address: 'a@example.com', mode: 'read_only' };
  const cases: [string, (c: any) => void][] = [
    ['raw secret in secretRefs', (c) => (c.accounts = [{ ...acct, secretRefs: { refreshToken: 'ya29.raw-token' } }])],
    ['bad mode', (c) => (c.accounts = [{ ...acct, mode: 'yolo' }])],
    ['bad kind', (c) => (c.accounts = [{ ...acct, kind: 'slack' }])],
    ['unknown top-level', (c) => (c.surprise = true)],
    ['raw owner id', (c) => (c.owner.telegramOwnerIdRef = '424242')],
    ['bad timezone', (c) => (c.owner.timezone = 'Mars/Olympus')],
    ['dup accounts', (c) => (c.accounts = [acct, acct])],
    ['bad quiet hours', (c) => (c.quietHours.start = '25:00')],
    ['raw password elsewhere', (c) => (c.broker.password = 'p')],
  ];
  for (const [name, mut] of cases) {
    const c = structuredClone(raw);
    mut(c);
    const r = validateConfig(c);
    assert.equal(r.ok, false, name);
  }
  const good = structuredClone(raw);
  good.accounts = [acct];
  assert.ok(validateConfig(good).ok);
});

test('schema validator refuses unsupported keywords', () => {
  assert.throws(() => validateSchema(1, { oneOf: [] }));
  assert.deepEqual(validateSchema('x', { type: 'string', pattern: '^x$' }), []);
});

test('secret refs: format and env resolution', async () => {
  assert.ok(isSecretRef('keychain:potts/telegram-bot-token'));
  assert.ok(isSecretRef('env:POTTS_KEY'));
  assert.ok(!isSecretRef('plain'));
  const r = await resolveSecretRef('env:POTTS_TEST_SECRET', { env: { POTTS_TEST_SECRET: 's3cret' } });
  assert.ok(r.ok && r.value === 's3cret');
  const k = await resolveSecretRef('keychain:svc/acct', { keychainLookup: async () => 'v' });
  assert.ok(k.ok && k.value === 'v');
  const miss = await resolveSecretRef('keychain:svc/acct', { keychainLookup: async () => { throw new Error('no'); } });
  assert.equal(miss.ok, false);
});
