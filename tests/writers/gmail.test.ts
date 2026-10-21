import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createEnv, createFakeGmail, fakeTokens, type Env } from './helpers.ts';
import {
  createGmailWriter, createMessageRouter, createApprovalBindingCheck, createMemoryAttachmentStore, messageViewOf, renderMessagePreview,
  parseMime, type WriterExecutor,
} from '../../src/connectors/writers/index.ts';
import { ExecutorRejectedError, type DispatchIntent } from '../../src/broker/executor.ts';
import { hashCanonical } from '../../src/core/hash.ts';

const PDF = new TextEncoder().encode('%PDF-1.4 fake resume bytes\n');
const PDF_SHA = createHash('sha256').update(PDF).digest('hex');

function setup(opts: { mailbox?: string; testHooks?: Parameters<typeof createEnv>[0]['testHooks'] } = {}) {
  const gmail = createFakeGmail(opts.mailbox ?? 'owner@example.com');
  const tokens = fakeTokens();
  const store = createMemoryAttachmentStore([PDF]);
  let writer!: WriterExecutor;
  const env = createEnv({
    ...(opts.testHooks ? { testHooks: opts.testHooks } : {}),
    executors: ({ db, clock }) => {
      writer = createGmailWriter({
        accountId: 'gmail-personal', accountAddress: 'owner@example.com', tokens, fetch: gmail.fetch, clock, attachments: store,
        approvalCheck: createApprovalBindingCheck(db), lookupSettleSeconds: 600,
      });
      return [createMessageRouter([writer])];
    },
  });
  return { env, gmail, tokens, store, writer: () => writer };
}

const email = (o: Record<string, unknown> = {}, p: Record<string, unknown> = {}) => ({
  kind: 'send_message',
  accountId: 'gmail-personal',
  destination: ['alice@example.org', 'bob@example.org'],
  payload: { channel: 'email', to: ['bob@example.org'], cc: ['alice@example.org'], subject: 'Thursday plan', body: 'Hi Bob,\n\nThursday at 5 works.\n\nAlex', ...p },
  summary: 'Reply to Bob about Thursday',
  ...o,
});

function proposeApproved(env: Env, input: unknown) {
  const p = env.broker.propose(input, 'openclaw');
  assert.ok(p.ok, p.ok ? '' : p.error.message);
  assert.equal(p.value.status, 'awaiting_approval');
  const a = env.approve(p.value.actionId);
  assert.ok(a.ok, a.ok ? '' : a.error.message);
  return p.value;
}

test('approved Gmail send happens exactly once and matches the approval preview', async () => {
  const { env, gmail } = setup();
  try {
    const input = email({ attachments: [{ name: 'resume.pdf', sha256: PDF_SHA }] }, { attachments: [{ name: 'resume.pdf', sha256: PDF_SHA, contentType: 'application/pdf', size: PDF.byteLength }] });
    const p = proposeApproved(env, input);
    const preview = env.owner.preview(env.broker.approvals.get(p.approvalId!)!.id)!;
    const text = renderMessagePreview(preview)!;
    for (const s of ['From: owner@example.com', 'To: bob@example.org', 'Cc: alice@example.org', 'Subject: Thursday plan', 'Thursday at 5 works.', 'resume.pdf', PDF_SHA, '27 B'])
      assert.ok(text.includes(s), `preview should include ${s}`);

    const r = await env.broker.execute(p.actionId);
    assert.ok(r.ok && r.value.status === 'succeeded', JSON.stringify(r));
    assert.equal(gmail.sent.length, 1);

    // The sent MIME equals the previewed content.
    const view = messageViewOf(preview)!;
    const m = parseMime(gmail.sent[0]!.mime);
    assert.equal(m.headers.get('from'), view.from!.address);
    assert.equal(m.headers.get('to'), view.to.join(', '));
    assert.equal(m.headers.get('cc'), view.cc.join(', '));
    assert.equal(m.subject, view.subject);
    assert.equal(m.body, view.body);
    assert.deepEqual(m.attachments.map((a) => [a.name, a.sha256, a.contentType]), view.attachments.map((a) => [a.name, a.sha256, a.contentType]));
    assert.equal(m.headers.get('message-id'), `<potts-${p.actionId}@example.com>`);
    assert.equal(m.headers.get('x-potts-action'), `potts-${p.actionId}`);

    // Executing again never re-sends.
    const again = await env.broker.execute(p.actionId);
    assert.ok(again.ok && again.value.status === 'succeeded' && again.value.alreadyDone);
    assert.equal(gmail.sent.length, 1);
  } finally {
    env.close();
  }
});

test('unapproved, changed, replayed, expired and cross-account sends are blocked', async () => {
  const { env, gmail, writer } = setup();
  try {
    // Unapproved.
    const u = env.broker.propose(email(), 'openclaw');
    assert.ok(u.ok);
    const r1 = await env.broker.execute(u.value.actionId);
    assert.equal(!r1.ok && r1.error.code, 'approval_missing');

    // Changed after approval: revision invalidates the approval.
    const c = proposeApproved(env, email());
    const rev = env.broker.revise(c.actionId, email({}, { body: 'Hi Bob, actually Friday.' }), 'openclaw');
    assert.ok(rev.ok);
    const r2 = await env.broker.execute(c.actionId);
    assert.equal(!r2.ok && r2.error.code, 'approval_missing');

    // Expired.
    const e = proposeApproved(env, email({}, { subject: 'Expiring' }));
    env.clock.advanceSeconds(86400 + 5);
    const r3 = await env.broker.execute(e.actionId);
    assert.equal(!r3.ok && r3.error.code, 'approval_expired');

    // Cross-account: approval bound to gmail-personal; action revised to gmail-work → invalidated.
    const x = proposeApproved(env, email({}, { subject: 'Cross' }));
    const rx = env.broker.revise(x.actionId, email({ accountId: 'gmail-work' }, { subject: 'Cross' }), 'openclaw');
    assert.ok(rx.ok);
    const r4 = await env.broker.execute(x.actionId);
    assert.equal(r4.ok, false);
    // Even if the owner approves the gmail-work version, there is no writer for that account: definitive failure, nothing sent.
    assert.ok(env.approve(x.actionId).ok);
    const r5 = await env.broker.execute(x.actionId);
    assert.ok(r5.ok && r5.value.status === 'failed', JSON.stringify(r5));
    assert.match(r5.ok && r5.value.status === 'failed' ? r5.value.reason : '', /no enabled writer for account gmail-work/);

    // Replay: a sent action's recorded intent handed straight to the writer again is refused (dispatch no longer in flight).
    const ok1 = proposeApproved(env, email({}, { subject: 'Replay' }));
    const done = await env.broker.execute(ok1.actionId);
    assert.ok(done.ok && done.value.status === 'succeeded');
    const row = env.db.prepare('SELECT intent_json FROM dispatches WHERE action_id = ?').get(ok1.actionId) as { intent_json: string };
    const intent = JSON.parse(row.intent_json) as DispatchIntent;
    await assert.rejects(writer().execute(intent, new AbortController().signal), (err: Error) => err instanceof ExecutorRejectedError && /not in flight/.test(err.message));
    // Replaying the owner's approval proof is rejected by the ingress.
    const live = env.broker.propose(email({}, { subject: 'Proof replay' }), 'openclaw');
    assert.ok(live.ok);
    const apr = env.broker.approvals.live(live.value.actionId)!;
    const proof = env.sign({ type: 'approve', approvalId: apr.id, bindingHash: apr.bindingHash });
    assert.ok(env.owner.handle(proof).ok);
    assert.equal(env.owner.handle(proof).ok, false);

    assert.equal(gmail.sent.length, 1, 'only the single legitimately approved message was sent');
  } finally {
    env.close();
  }
});

test('writer guards: tampered payload, wrong sender address, recipient mismatch and foreign mailbox token', async () => {
  const { env, gmail, writer } = setup();
  try {
    const base = (): DispatchIntent => {
      const payload = email().payload;
      return {
        dispatchId: 'dsp_x', actionId: 'act_x', attempt: 1, kind: 'send_message', accountId: 'gmail-personal', accountAddress: 'owner@example.com',
        destination: ['alice@example.org', 'bob@example.org'], payload, payloadHash: hashCanonical(payload), attachments: [], idempotencyKey: 'potts-act_x', createdAt: env.clock.nowIso(),
      };
    };
    const sig = new AbortController().signal;
    const w = createGmailWriter({ accountId: 'gmail-personal', accountAddress: 'owner@example.com', tokens: fakeTokens(), fetch: gmail.fetch, clock: env.clock });
    await assert.rejects(w.execute({ ...base(), payload: { ...email().payload, body: 'tampered' } }, sig), /approved payload hash/);
    await assert.rejects(w.execute({ ...base(), accountAddress: 'work@example.com' }, sig), /sender address/);
    await assert.rejects(w.execute({ ...base(), accountId: 'gmail-work' }, sig), /refuses a dispatch for account gmail-work/);
    await assert.rejects(w.execute({ ...base(), destination: ['bob@example.org', 'mallory@example.org'] }, sig), /recipients/);
    gmail.state.profileAddress = 'someone-else@example.com';
    await assert.rejects(w.execute(base(), sig), /different mailbox/);
    // The production writer (with binding check) refuses an intent that has no dispatch row at all.
    gmail.state.profileAddress = 'owner@example.com';
    await assert.rejects(writer().execute(base(), sig), /approval check failed: dispatch record not found/);
    assert.equal(gmail.state.sendCalls, 0);
  } finally {
    env.close();
  }
});

test('attachment bytes must match the approved hash; mismatch fails definitively and nothing is sent', async () => {
  const gmail = createFakeGmail('owner@example.com');
  const store = createMemoryAttachmentStore();
  const other = new TextEncoder().encode('different bytes');
  // Store maps the approved hash to the wrong bytes (simulates a swapped file).
  (store as unknown as { get: (h: string) => Promise<Uint8Array> }).get = async () => other;
  const env = createEnv({
    executors: ({ db, clock }) => [createMessageRouter([createGmailWriter({ accountId: 'gmail-personal', accountAddress: 'owner@example.com', tokens: fakeTokens(), fetch: gmail.fetch, clock, attachments: store, approvalCheck: createApprovalBindingCheck(db) })])],
  });
  try {
    const p = proposeApproved(env, email({ attachments: [{ name: 'resume.pdf', sha256: PDF_SHA }] }, { attachments: [{ name: 'resume.pdf', sha256: PDF_SHA, contentType: 'application/pdf', size: PDF.byteLength }] }));
    const r = await env.broker.execute(p.actionId);
    assert.ok(r.ok && r.value.status === 'failed');
    assert.match(r.ok && r.value.status === 'failed' ? r.value.reason : '', /do not match the approved hash/);
    assert.equal(gmail.state.sendCalls, 0);
  } finally {
    env.close();
  }
});

test('crash after Gmail accepted the send: recover + lookup reconciles, no duplicate', async () => {
  let crash = true;
  const { env, gmail } = setup({ testHooks: { afterProviderAccept: () => { if (crash) throw new Error('simulated crash before receipt persisted'); } } });
  let env2: Env | undefined;
  try {
    const p = proposeApproved(env, email());
    await assert.rejects(env.broker.execute(p.actionId), /simulated crash/);
    assert.equal(gmail.sent.length, 1);
    crash = false;
    env2 = env.reopen();
    assert.deepEqual(env2.broker.recover().uncertain, [p.actionId]);
    const blocked = await env2.broker.execute(p.actionId);
    assert.equal(!blocked.ok && blocked.error.code, 'uncertain_requires_reconcile');
    const rec = await env2.broker.reconcile(p.actionId);
    assert.ok(rec.ok && rec.value.status === 'sent', JSON.stringify(rec));
    assert.equal(rec.ok && rec.value.status === 'sent' && rec.value.providerOperationId, 'gmail:gm1');
    const again = await env2.broker.execute(p.actionId);
    assert.ok(again.ok && again.value.status === 'succeeded' && again.value.alreadyDone);
    assert.equal(gmail.sent.length, 1);
  } finally {
    (env2 ?? env).close();
  }
});

test('lost response (network error / 5xx after accept) is uncertain, reconciled by Message-ID or X-Potts-Action', async () => {
  for (const mode of ['network_after_accept', 'http500_after_accept'] as const) {
    for (const rewrite of [false, true]) {
      const { env, gmail } = setup();
      try {
        gmail.state.mode = mode;
        gmail.state.rewriteMessageId = rewrite;
        const p = proposeApproved(env, email());
        const r = await env.broker.execute(p.actionId);
        assert.ok(r.ok && r.value.status === 'uncertain', `${mode}: ${JSON.stringify(r)}`);
        const rec = await env.broker.reconcile(p.actionId);
        assert.ok(rec.ok && rec.value.status === 'sent', `${mode}/${rewrite}: ${JSON.stringify(rec)}`);
        assert.equal(gmail.sent.length, 1);
      } finally {
        env.close();
      }
    }
  }
});

test('never-accepted send: lookup stays unknown inside the settle window, then not_found allows exactly one retry', async () => {
  const { env, gmail } = setup();
  try {
    gmail.state.mode = 'network_before_accept';
    const p = proposeApproved(env, email());
    const r = await env.broker.execute(p.actionId);
    assert.ok(r.ok && r.value.status === 'uncertain');
    const early = await env.broker.reconcile(p.actionId);
    assert.ok(early.ok && early.value.status === 'still_uncertain');
    env.clock.advanceSeconds(601);
    const late = await env.broker.reconcile(p.actionId);
    assert.ok(late.ok && late.value.status === 'not_sent', JSON.stringify(late));
    gmail.state.mode = 'ok';
    const retry = await env.broker.execute(p.actionId);
    assert.ok(retry.ok && retry.value.status === 'succeeded', JSON.stringify(retry));
    assert.equal(gmail.sent.length, 1);
    // Same Message-ID on the retry (idempotency key is per action).
    assert.equal(parseMime(gmail.sent[0]!.mime).headers.get('message-id'), `<potts-${p.actionId}@example.com>`);
  } finally {
    env.close();
  }
});

test('provider 4xx is a definitive failure: approval released, nothing sent', async () => {
  const { env, gmail } = setup();
  try {
    gmail.state.mode = 'reject400';
    const p = proposeApproved(env, email());
    const r = await env.broker.execute(p.actionId);
    assert.ok(r.ok && r.value.status === 'failed');
    assert.equal(gmail.sent.length, 0);
    assert.equal(env.broker.getAction(p.actionId)!.status, 'failed');
  } finally {
    env.close();
  }
});

test('threaded reply: In-Reply-To/References headers and Gmail threadId; non-ASCII subject encoded', async () => {
  const { env, gmail, tokens } = setup();
  try {
    const p = proposeApproved(env, email({}, {
      subject: 'Re: Café meeting — résumé ✓',
      reply: { inReplyTo: '<abc123@mail.example.org>', references: ['<root1@mail.example.org>'], providerThreadId: '18c0ffee', context: { from: 'bob@example.org', subject: 'Café meeting', snippet: 'Are you free Thursday?' } },
    }));
    const preview = renderMessagePreview(env.owner.preview(p.approvalId!)!)!;
    assert.match(preview, /In reply to: "Café meeting" from bob@example.org/);
    assert.match(preview, /> Are you free Thursday\?/);
    const r = await env.broker.execute(p.actionId);
    assert.ok(r.ok && r.value.status === 'succeeded');
    const s = gmail.sent[0]!;
    assert.equal(s.requestThreadId, '18c0ffee');
    const m = parseMime(s.mime);
    assert.equal(m.headers.get('in-reply-to'), '<abc123@mail.example.org>');
    assert.equal(m.headers.get('references')!.replace(/\s+/g, ' '), '<root1@mail.example.org> <abc123@mail.example.org>');
    assert.match(s.mime, /^Subject: =\?UTF-8\?B\?/m);
    assert.equal(m.subject, 'Re: Café meeting — résumé ✓');
    assert.ok(s.mime.split('\r\n').every((l) => l.length <= 998), 'no line exceeds the RFC 5322 limit');
    assert.ok(tokens.requests.every((t) => t.purpose === 'send' && t.scopes.includes('https://www.googleapis.com/auth/gmail.send')));
  } finally {
    env.close();
  }
});

test('payload validation rejects header injection and unknown fields at proposal-to-send time', async () => {
  const { env, gmail } = setup();
  try {
    for (const bad of [
      { subject: 'Hi\r\nBcc: attacker@evil.example' },
      { to: ['bob@example.org\r\nBcc: x@evil.example'] },
      { approved: true },
    ]) {
      const p = proposeApproved(env, email({}, bad));
      const r = await env.broker.execute(p.actionId);
      assert.ok(r.ok && r.value.status === 'failed', JSON.stringify(bad));
    }
    assert.equal(gmail.state.sendCalls, 0);
  } finally {
    env.close();
  }
});
