/**
 * Evidence: "Approval is replayed, expired or used after editing the payload"
 * → no action; a new owner approval is required.
 * Runs through the real wiring: Gmail writer (fake Gmail API), approval
 * notification via the owner channel, the daemon's dispatch job.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeNet, gmailAccount, makeHome, markConnected, routeGmail, sendPayload, startWorld, tokenSetFor } from './_harness.ts';

const START = '2026-10-07T14:00:00Z';

test('E2E-03 replayed, expired and edited approvals never send; a fresh approval is required', async () => {
  const home = makeHome({
    accounts: [gmailAccount('approval_required')],
    policy: { approvalTtlSeconds: 3600 },
    potts: (c) => {
      (c.monitoring as Record<string, unknown>).enabled = false;
      c.writers = { lookupSettleSeconds: 600, accounts: [{ accountId: 'gmail-personal', enabled: true, kinds: ['send_message'] }] };
    },
  });
  const net = createFakeNet();
  const gmail = routeGmail(net);
  const w = await startWorld({
    home, start: START, net, keychain: { 'potts/google-oauth-client-secret': 'cs' },
    tokens: {
      'gmail-personal': tokenSetFor('google', START),
      'gmail-personal.send': tokenSetFor('google', START, { scope: 'https://www.googleapis.com/auth/gmail.send' }),
    },
  });
  try {
    markConnected(w, 'gmail-personal', 'google');
    markConnected(w, 'gmail-personal.send', 'google', 'https://www.googleapis.com/auth/gmail.send');
    assert.ok(w.d.runtime().executors.includes('message-router'));

    // (a) approved once → sent once, through the daemon's own dispatch job.
    const a = w.d.broker.propose(sendPayload('bob@example.com', 'See you at 5'), 'openclaw/potts');
    assert.ok(a.ok && a.value.status === 'awaiting_approval');
    await w.advance(30_000, 15_000);
    assert.ok(w.channel.sent.some((m) => m.type === 'approval' && m.approvalId === a.value.approvalId), 'owner was asked with the exact approval');
    assert.equal(gmail.sent.length, 0, 'nothing sent before approval');
    const live = w.d.broker.approvals.live(a.value.actionId)!;
    const proof = w.sign({ type: 'approve', approvalId: live.id, bindingHash: live.bindingHash });
    assert.ok(w.d.owner!.handle(proof).ok);
    await w.advance(30_000, 15_000);
    assert.equal(gmail.sent.length, 1);
    assert.equal(w.d.broker.getAction(a.value.actionId)!.status, 'succeeded');
    assert.equal(gmail.sent[0]!.pottsAction, `potts-${a.value.actionId}`);

    // (b) replay: the same signed approval and a re-execute do nothing.
    const replay = w.d.owner!.handle(proof);
    assert.equal(!replay.ok && replay.error.code, 'ingress_replayed');
    const again = await w.d.broker.execute(a.value.actionId);
    assert.ok(again.ok && again.value.status === 'succeeded' && again.value.alreadyDone === true);
    // Same content proposed again is a NEW action that needs a NEW approval.
    const a2 = w.d.broker.propose(sendPayload('bob@example.com', 'See you at 5'), 'openclaw/potts');
    assert.ok(a2.ok && a2.value.status === 'awaiting_approval');
    const reuse = w.d.owner!.handle(w.sign({ type: 'approve', approvalId: live.id, bindingHash: live.bindingHash }));
    assert.equal(reuse.ok, false, 'an old approval id cannot approve the new action');
    await w.advance(60_000, 15_000);
    assert.equal(gmail.sent.length, 1);

    // (c) edited after approval: the approval is invalidated; nothing is sent; a new approval is requested.
    const b = w.d.broker.propose(sendPayload('carol@example.com', 'Draft v1'), 'openclaw/potts');
    assert.ok(b.ok);
    await w.d.broker.execute(b.value.actionId); // no-op without approval
    w.owner({ type: 'pause_integration', integration: 'gmail', reason: 'hold while editing' });
    assert.ok(w.approve(b.value.actionId).ok);
    const oldApproval = w.d.broker.approvals.live(b.value.actionId)!;
    const rev = w.d.broker.revise(b.value.actionId, sendPayload('carol@example.com', 'Draft v2 (edited after approval)'), 'openclaw/potts');
    assert.ok(rev.ok && rev.value.status === 'held', 'held while paused; the edit needs a fresh approval');
    assert.equal(w.d.broker.approvals.get(oldApproval.id)!.status, 'invalidated');
    w.owner({ type: 'resume', scope: 'integration:gmail' });
    await w.advance(60_000, 15_000);
    assert.equal(gmail.sent.length, 1, 'edited payload was not sent on the old approval');
    const exB = await w.d.broker.execute(b.value.actionId);
    assert.equal(!exB.ok && exB.error.code, 'approval_missing');

    // (d) expired: approved, held by a pause past the approval lifetime, then resumed → expired, re-requested.
    const c = w.d.broker.propose(sendPayload('dave@example.com', 'Later'), 'openclaw/potts');
    assert.ok(c.ok);
    w.owner({ type: 'pause_integration', integration: 'gmail', reason: 'travelling' });
    assert.ok(w.approve(c.value.actionId).ok);
    await w.advance(2 * 3600_000, 5 * 60_000);
    w.owner({ type: 'resume', scope: 'integration:gmail' });
    const exC = await w.d.broker.execute(c.value.actionId);
    assert.equal(!exC.ok && exC.error.code, 'approval_expired');
    await w.advance(60_000, 15_000);
    assert.equal(gmail.sent.length, 1, 'expired approval sent nothing');
    const fresh = w.d.broker.approvals.live(c.value.actionId);
    assert.ok(fresh && fresh.status === 'pending', 'a new owner approval is required');
    // Expiry of an unanswered request: approving after expiry fails.
    await w.advance(2 * 3600_000, 10 * 60_000);
    const late = w.owner({ type: 'approve', approvalId: fresh!.id, bindingHash: fresh!.bindingHash });
    assert.equal(!late.ok && late.error.code, 'approval_expired');
    assert.equal(gmail.sent.length, 1);
    assert.equal(w.d.audit.verify().ok, true);
  } finally {
    await w.close();
  }
});
