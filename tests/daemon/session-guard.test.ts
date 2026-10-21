import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSessionGuard, findOverflowFailures, lastOwnerMessage, ownerAgentId, type CliResult } from '../../src/daemon/session-guard.ts';
import { createLogger } from '../../src/core/log.ts';

const KEY = 'agent:main:telegram:direct:42';
const processed = (id: string, outcome = 'error', key = KEY) =>
  `T [diagnostic] message processed: channel=telegram chatId=telegram:42 messageId=${id} sessionId=s sessionKey=${key} outcome=${outcome} duration=1ms`;
const overflow = 'T [agent/embedded] incomplete turn detected: runId=r sessionId=s provider=lmstudio/qwen stopReason=length hasLastAssistant=yes';

test('findOverflowFailures: only owner error turns preceded by a context signal', () => {
  const lines = [overflow, processed('10'), 'T unrelated', processed('11'), overflow, processed('12', 'ok'), overflow, processed('13', 'error', 'agent:main:other')];
  assert.deepEqual(findOverflowFailures(lines, KEY).map((f) => f.messageId), ['10']);
  assert.deepEqual(findOverflowFailures(['T [agent] Input does not fit in context length. x', processed('20')], KEY).map((f) => f.messageId), ['20']);
  assert.deepEqual(findOverflowFailures(['T model timeout', processed('21')], KEY), [], 'non-context failures are left alone');
});

function fixtureDb(path: string, messageId: string, text: string) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE session_windows (session_id TEXT, session_key TEXT); CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT)');
  db.prepare('INSERT INTO session_windows VALUES (?, ?)').run('s1', KEY);
  const ev = (seq: number, m: unknown) => db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?)').run('s1', seq, JSON.stringify({ message: m }));
  ev(1, { role: 'user', content: 'older', __openclaw: { senderIsOwner: true, transport: { messageId: '1' } } });
  ev(2, { role: 'user', content: 'not owner', __openclaw: { senderIsOwner: false, transport: { messageId: messageId } } });
  ev(3, { role: 'user', content: text, __openclaw: { senderIsOwner: true, transport: { messageId } } });
  ev(4, { role: 'assistant', content: [{ type: 'text', text: 'x' }] });
  db.close();
}

test('lastOwnerMessage: owner text for the failed message id, never other senders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'potts-guard-'));
  try {
    const dbp = join(dir, 'a.sqlite');
    fixtureDb(dbp, '77', 'you ready to talk?');
    assert.equal(lastOwnerMessage(dbp, KEY, '77'), 'you ready to talk?');
    assert.equal(lastOwnerMessage(dbp, KEY, '1'), 'older');
    assert.equal(lastOwnerMessage(dbp, 'agent:main:nope'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guard: starts at log end, resets + replays once, respects cooldown, ignores repeats', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'potts-guard-'));
  try {
    const logp = join(dir, 'gateway.log');
    const dbp = join(dir, 'a.sqlite');
    fixtureDb(dbp, '77', 'you ready to talk?');
    writeFileSync(logp, `${overflow}\n${processed('5')}\n`); // history before start is ignored
    const calls: string[][] = [];
    let now = 1_000_000;
    const guard = createSessionGuard({
      logPath: logp, owner: () => ({ agentId: 'main', sessionKey: KEY, agentDbPath: dbp }),
      runCli: async (args): Promise<CliResult> => { calls.push(args); return { code: 0, stdout: args[0] === 'gateway' ? '{"ok": true}' : '', stderr: '' }; },
      clock: { nowMs: () => now, now: () => new Date(now) } as never,
      log: createLogger({ sink: () => {} }),
    });
    assert.deepEqual(await guard.tick(), { checked: 0 });
    appendFileSync(logp, `${overflow}\n${processed('77')}\n`);
    const r = await guard.tick();
    assert.equal(r.recovered, 'reset_and_replayed');
    assert.deepEqual(calls[0]!.slice(0, 3), ['gateway', 'call', 'sessions.reset']);
    assert.ok(calls[1]!.includes('--deliver') && calls[1]!.at(-1) === 'you ready to talk?');
    assert.equal(calls[1]![calls[1]!.indexOf('--agent') + 1], 'main');
    appendFileSync(logp, `${overflow}\n${processed('78')}\n`);
    now += 60_000;
    assert.equal((await guard.tick()).skipped, 'cooldown', 'no reset loop');
    assert.equal(calls.length, 2);
    appendFileSync(logp, `${processed('77')}\n${overflow}\n${processed('78')}\n`);
    now += 20 * 60_000;
    assert.deepEqual(await guard.tick(), { checked: 3 }, 'already-handled messages are not replayed again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ownerAgentId: follows the Telegram DM binding (coordinator), main otherwise', () => {
  const cfg = { bindings: [
    { agentId: 'other', match: { channel: 'telegram', peer: { kind: 'direct', id: '7' } } },
    { agentId: 'potts-coordinator', match: { channel: 'telegram', peer: { kind: 'direct', id: '42' } } },
  ] };
  assert.equal(ownerAgentId(cfg, '42'), 'potts-coordinator');
  assert.equal(ownerAgentId(cfg, '99'), 'main');
  assert.equal(ownerAgentId({}, '42'), 'main');
  assert.equal(ownerAgentId({ bindings: [{ agentId: '../x', match: { channel: 'telegram', peer: { kind: 'direct', id: '42' } } }] }, '42'), 'main', 'no path-like agent ids');
});

test('guard: watches and replays into the coordinator session when the DM is bound to it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'potts-guard-'));
  try {
    const logp = join(dir, 'gateway.log');
    const dbp = join(dir, 'q.sqlite');
    const QKEY = 'agent:potts-coordinator:telegram:direct:42';
    const db = new DatabaseSync(dbp);
    db.exec('CREATE TABLE session_windows (session_id TEXT, session_key TEXT); CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT)');
    db.prepare('INSERT INTO session_windows VALUES (?, ?)').run('q1', QKEY);
    db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?)').run('q1', 1, JSON.stringify({ message: { role: 'user', content: 'still there?', __openclaw: { senderIsOwner: true, transport: { messageId: '90' } } } }));
    db.close();
    writeFileSync(logp, '');
    const calls: string[][] = [];
    const guard = createSessionGuard({
      logPath: logp, owner: () => ({ agentId: 'potts-coordinator', sessionKey: QKEY, agentDbPath: dbp }),
      runCli: async (args): Promise<CliResult> => { calls.push(args); return { code: 0, stdout: '{"ok": true}', stderr: '' }; },
      clock: { nowMs: () => 5_000_000, now: () => new Date(5_000_000) } as never,
      log: createLogger({ sink: () => {} }),
    });
    await guard.tick();
    appendFileSync(logp, `${overflow}\n${processed('91', 'error', KEY)}\n`);
    assert.deepEqual(await guard.tick(), { checked: 2 }, 'the old main session is no longer the owner chat');
    appendFileSync(logp, `${overflow}\n${processed('90', 'error', QKEY)}\n`);
    assert.equal((await guard.tick()).recovered, 'reset_and_replayed');
    assert.equal(JSON.parse(calls[0]![4]!).key, QKEY);
    assert.equal(calls[1]![calls[1]!.indexOf('--agent') + 1], 'potts-coordinator');
    assert.equal(calls[1]!.at(-1), 'still there?');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
