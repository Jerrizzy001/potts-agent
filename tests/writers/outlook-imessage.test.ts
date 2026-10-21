import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createEnv, createFakeGraph, fakeTokens, type Env } from './helpers.ts';
import {
  createOutlookWriter, createImessageWriter, createMessageRouter, createApprovalBindingCheck, createProviderRefStore, registerMessageWriters,
  renderMessagePreview, chunkPreview, IMESSAGE_SEND_SCRIPT, WRITERS_CONFIG_SCHEMA, type OsascriptRunner,
} from '../../src/connectors/writers/index.ts';
import { toAppleNanos } from '../../src/connectors/imessage/writer-chatdb.ts';
import { createExecutorRegistry } from '../../src/broker/executor.ts';
import { createAccountRegistry } from '../../src/core/config.ts';
import { createFakeClock } from '../../src/core/clock.ts';
import { ACCOUNTS } from './helpers.ts';

function approved(env: Env, input: unknown) {
  const p = env.broker.propose(input, 'openclaw');
  assert.ok(p.ok, p.ok ? '' : p.error.message);
  assert.ok(env.approve(p.value.actionId).ok);
  return p.value;
}

// ------------------------------------------------------------------ Outlook

function outlookSetup(testHooks?: Parameters<typeof createEnv>[0]['testHooks']) {
  const graph = createFakeGraph('alex@outlook.example');
  const env = createEnv({
    ...(testHooks ? { testHooks } : {}),
    executors: ({ db, clock }) => [createMessageRouter([createOutlookWriter({
      accountId: 'outlook-personal', accountAddress: 'alex@outlook.example', tokens: fakeTokens(), fetch: graph.fetch, clock,
      refs: createProviderRefStore(db, clock), approvalCheck: createApprovalBindingCheck(db),
    })])],
  });
  return { env, graph };
}
const outlookMail = (p: Record<string, unknown> = {}) => ({
  kind: 'send_message', accountId: 'outlook-personal', destination: ['prof@school.example'],
  payload: { channel: 'email', to: ['prof@school.example'], subject: 'Extension request', body: 'Hello Professor,\n\nCould I have one more day?\n\nAlex', ...p },
});

test('Outlook: approved send creates a draft, verifies it, persists the immutable id, then sends exactly once', async () => {
  const { env, graph } = outlookSetup();
  try {
    const p = approved(env, outlookMail());
    const r = await env.broker.execute(p.actionId);
    assert.ok(r.ok && r.value.status === 'succeeded', JSON.stringify(r));
    assert.equal(graph.sentMessages().length, 1);
    const m = graph.sentMessages()[0]!;
    assert.equal(m.internetMessageId, `<potts-${p.actionId}@outlook.example>`);
    assert.deepEqual(m.internetMessageHeaders, [{ name: 'X-Potts-Action', value: `potts-${p.actionId}` }]);
    assert.equal((m.body as { content: string }).content, outlookMail().payload.body);
    const refs = env.db.prepare('SELECT ref_value FROM writer_provider_refs WHERE action_id = ?').all(p.actionId) as { ref_value: string }[];
    assert.deepEqual(refs.map((x) => x.ref_value), [m.id]);
    const again = await env.broker.execute(p.actionId);
    assert.ok(again.ok && again.value.status === 'succeeded' && again.value.alreadyDone);
    assert.equal(graph.state.sendCalls, 1);
  } finally {
    env.close();
  }
});

test('Outlook: crash after send accepted → lookup by persisted immutable id finds it; no duplicate', async () => {
  let crash = true;
  const { env, graph } = outlookSetup({ afterProviderAccept: () => { if (crash) throw new Error('crash'); } });
  let env2: Env | undefined;
  try {
    const p = approved(env, outlookMail());
    await assert.rejects(env.broker.execute(p.actionId));
    crash = false;
    env2 = env.reopen();
    env2.broker.recover();
    const rec = await env2.broker.reconcile(p.actionId);
    assert.ok(rec.ok && rec.value.status === 'sent', JSON.stringify(rec));
    assert.equal(graph.state.sendCalls, 1);
  } finally {
    (env2 ?? env).close();
  }
});

test('Outlook: lost send response is uncertain; draft-still-unsent becomes not_found only after settling', async () => {
  const { env, graph } = outlookSetup();
  try {
    graph.state.sendMode = 'network_after_accept';
    const p = approved(env, outlookMail());
    const r = await env.broker.execute(p.actionId);
    assert.ok(r.ok && r.value.status === 'uncertain');
    const rec = await env.broker.reconcile(p.actionId);
    assert.ok(rec.ok && rec.value.status === 'sent');

    graph.state.sendMode = 'network_before_accept';
    const q = approved(env, outlookMail({ subject: 'Second' }));
    const r2 = await env.broker.execute(q.actionId);
    assert.ok(r2.ok && r2.value.status === 'uncertain');
    const early = await env.broker.reconcile(q.actionId);
    assert.ok(early.ok && early.value.status === 'still_uncertain');
    env.clock.advanceSeconds(700);
    const late = await env.broker.reconcile(q.actionId);
    assert.ok(late.ok && late.value.status === 'not_sent');
    assert.equal(graph.sentMessages().length, 1);
  } finally {
    env.close();
  }
});

test('Outlook: server-side draft that differs from the approved payload is never sent; wrong mailbox token refused', async () => {
  const { env, graph } = outlookSetup();
  try {
    graph.state.tamperDraft = true;
    const p = approved(env, outlookMail());
    const r = await env.broker.execute(p.actionId);
    assert.ok(r.ok && r.value.status === 'failed');
    assert.match(r.ok && r.value.status === 'failed' ? r.value.reason : '', /differs from the approved payload \(to\)/);
    graph.state.tamperDraft = false;
    graph.state.meAddress = 'other@outlook.example';
    const q = approved(env, outlookMail({ subject: 'Again' }));
    const r2 = await env.broker.execute(q.actionId);
    assert.ok(r2.ok && r2.value.status === 'failed');
    assert.equal(graph.state.sendCalls, 0);
  } finally {
    env.close();
  }
});

test('Outlook: threaded reply via createReply is rewritten to exactly the approved content', async () => {
  const { env, graph } = outlookSetup();
  try {
    const p = approved(env, outlookMail({ subject: 'RE: Assignment 2', reply: { inReplyTo: '<orig@school.example>', providerMessageId: 'AAMkOrig1' } }));
    const r = await env.broker.execute(p.actionId);
    assert.ok(r.ok && r.value.status === 'succeeded', JSON.stringify(r));
    const m = graph.sentMessages()[0]!;
    assert.equal(m.replyTo, 'AAMkOrig1');
    assert.equal(m.subject, 'RE: Assignment 2');
    assert.deepEqual((m.toRecipients as { emailAddress: { address: string } }[]).map((x) => x.emailAddress.address), ['prof@school.example']);
  } finally {
    env.close();
  }
});

// ------------------------------------------------------------------ iMessage

function fakeChatDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER, is_from_me INTEGER, date INTEGER, error INTEGER DEFAULT 0);`);
  db.prepare('INSERT INTO handle (ROWID, id) VALUES (1, ?)').run('+14165550123');
  return db;
}

function imessageSetup(runner: OsascriptRunner) {
  const chatDbPath = join(mkdtempSync(join(tmpdir(), 'potts-chatdb-')), 'chat.db');
  const env = createEnv({
    executors: ({ db }) => [createMessageRouter([createImessageWriter({ accountId: 'imessage-owner', accountAddress: 'owner@icloud.example', runOsascript: runner, approvalCheck: createApprovalBindingCheck(db), chatDbPath })])],
  });
  return { env, chatDbPath };
}
const text = (body = 'On my way, 10 min') => ({ kind: 'send_message', accountId: 'imessage-owner', destination: ['+14165550123'], payload: { channel: 'imessage', to: ['+14165550123'], body } });

test('iMessage: fixed AppleScript; handle and text passed as argv (no script injection); sent once', async () => {
  const calls: string[][] = [];
  const { env } = imessageSetup(async (args) => {
    calls.push(args);
    return { code: 0, stdout: 'POTTS_SENT\n', stderr: '' };
  });
  try {
    const evil = 'hi" & (do shell script "rm -rf ~") & "';
    const p = approved(env, text(evil));
    const preview = renderMessagePreview(env.owner.preview(p.approvalId!)!)!;
    assert.match(preview, /send iMessage/);
    const r = await env.broker.execute(p.actionId);
    assert.ok(r.ok && r.value.status === 'succeeded');
    assert.equal(calls.length, 1);
    const args = calls[0]!;
    const scriptLines = args.filter((_, i) => args[i - 1] === '-e');
    assert.deepEqual(scriptLines, [...IMESSAGE_SEND_SCRIPT]);
    assert.deepEqual(args.slice(-3), ['+14165550123', evil, '']);
    assert.ok(!scriptLines.some((l) => l.includes('rm -rf')));
    const again = await env.broker.execute(p.actionId);
    assert.ok(again.ok && again.value.status === 'succeeded' && again.value.alreadyDone);
    assert.equal(calls.length, 1);
  } finally {
    env.close();
  }
});

test('iMessage: participant/permission errors are definitive; post-send errors uncertain and never auto-resent', async () => {
  let mode: 'reject' | 'perm' | 'crash' = 'reject';
  let calls = 0;
  const { env, chatDbPath } = imessageSetup(async () => {
    calls++;
    if (mode === 'reject') return { code: 0, stdout: 'POTTS_REJECT:-1728:Can’t get participant', stderr: '' };
    if (mode === 'perm') return { code: 0, stdout: 'POTTS_REJECT:-1743:Not authorized to send Apple events to Messages.', stderr: '' };
    return { code: 1, stdout: '', stderr: 'execution error: Messages got an error: connection invalid (-609)' };
  });
  try {
    const a = approved(env, text('first'));
    const r1 = await env.broker.execute(a.actionId);
    assert.ok(r1.ok && r1.value.status === 'failed');
    mode = 'perm';
    const b = approved(env, text('second'));
    const r2 = await env.broker.execute(b.actionId);
    assert.ok(r2.ok && r2.value.status === 'failed');
    assert.match(r2.ok && r2.value.status === 'failed' ? r2.value.reason : '', /Automation permission/);

    mode = 'crash';
    const c = approved(env, text('Running late, start without me'));
    const r3 = await env.broker.execute(c.actionId);
    assert.ok(r3.ok && r3.value.status === 'uncertain');
    // chat.db has no matching message → stays uncertain (never not_found), even long after.
    const cdb = fakeChatDb(chatDbPath);
    env.clock.advanceSeconds(3600);
    const rec1 = await env.broker.reconcile(c.actionId);
    assert.ok(rec1.ok && rec1.value.status === 'still_uncertain');
    const blocked = await env.broker.execute(c.actionId);
    assert.equal(!blocked.ok && blocked.error.code, 'uncertain_requires_reconcile');
    // Messages actually sent it (text stored only in attributedBody, as on recent macOS) → found.
    const intentAt = env.broker.dispatches(c.actionId)[0]!.createdAt;
    cdb.prepare('INSERT INTO message (guid, text, attributedBody, handle_id, is_from_me, date, error) VALUES (?,?,?,?,?,?,0)').run(
      'GUID-ABC', null, Buffer.concat([Buffer.from([4, 11, 0x73, 0x74]), Buffer.from('Running late, start without me'), Buffer.from([0x86])]), 1, 1, toAppleNanos(new Date(Date.parse(intentAt) + 2000).toISOString()),
    );
    cdb.close();
    const rec2 = await env.broker.reconcile(c.actionId);
    assert.ok(rec2.ok && rec2.value.status === 'sent', JSON.stringify(rec2));
    assert.equal(rec2.ok && rec2.value.status === 'sent' && rec2.value.providerOperationId, 'imessage:GUID-ABC');
    assert.equal(calls, 3);
  } finally {
    env.close();
  }
});

test('iMessage: attachments and group chats are rejected before osascript runs', async () => {
  let calls = 0;
  const { env } = imessageSetup(async () => {
    calls++;
    return { code: 0, stdout: 'POTTS_SENT', stderr: '' };
  });
  try {
    const sha = 'a'.repeat(64);
    const a = approved(env, { ...text(), attachments: [{ name: 'pic.jpg', sha256: sha }] });
    const r1 = await env.broker.execute(a.actionId);
    assert.ok(r1.ok && r1.value.status === 'failed');
    const g = approved(env, { kind: 'send_message', accountId: 'imessage-owner', destination: ['+14165550123', '+14165550124'], payload: { channel: 'imessage', to: ['+14165550123', '+14165550124'], body: 'hi all' } });
    const r2 = await env.broker.execute(g.actionId);
    assert.ok(r2.ok && r2.value.status === 'failed');
    assert.equal(calls, 0);
  } finally {
    env.close();
  }
});

// ------------------------------------------------------------------ preview + registration

test('preview chunking keeps the full body across Telegram-sized parts', () => {
  const body = Array.from({ length: 400 }, (_, i) => `line ${i} of a long message`).join('\n');
  const chunks = chunkPreview(`header\n${body}`, 1000);
  assert.ok(chunks.length > 1 && chunks.every((c) => c.length <= 1000 + 12));
  const rejoined = chunks.map((c) => c.replace(/^\[\d+\/\d+\]\n/, '')).join('\n');
  assert.equal(rejoined, `header\n${body}`);
});

test('registration is disabled by default and refuses unsafe account setups', () => {
  const clock = createFakeClock();
  const env = createEnv({ executors: () => [] });
  try {
    const reg = createExecutorRegistry();
    const deps = { db: env.db, clock, accounts: createAccountRegistry(ACCOUNTS), tokens: fakeTokens() };
    assert.deepEqual(registerMessageWriters(reg, undefined, deps), []);
    assert.deepEqual(registerMessageWriters(reg, { accounts: [{ accountId: 'gmail-personal', enabled: false }] }, deps), []);
    assert.equal(reg.list().length, 0);
    assert.throws(() => registerMessageWriters(reg, { accounts: [{ accountId: 'gmail-drafts', enabled: true }] }, deps), /cannot send/);
    assert.throws(() => registerMessageWriters(reg, { accounts: [{ accountId: 'gmail-personal', enabled: true, kinds: ['support_reply'] }] }, deps), /support-purpose/);
    const names = registerMessageWriters(reg, { accounts: [{ accountId: 'gmail-personal', enabled: true }, { accountId: 'outlook-personal', enabled: true }, { accountId: 'imessage-owner', enabled: true }] }, deps);
    assert.deepEqual(names, ['gmail-writer:gmail-personal', 'outlook-writer:outlook-personal', 'imessage-writer:imessage-owner']);
    assert.equal(reg.list().length, 1);
    assert.equal(reg.forKind('send_message')!.name, 'message-router');
    const root = JSON.parse(readFileSync(new URL('../../config/potts.schema.json', import.meta.url), 'utf8')) as { properties: Record<string, unknown> };
    assert.deepEqual(root.properties.writers, JSON.parse(JSON.stringify(WRITERS_CONFIG_SCHEMA)));
  } finally {
    env.close();
  }
});
