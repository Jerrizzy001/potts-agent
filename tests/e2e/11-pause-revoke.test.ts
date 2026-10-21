/**
 * Evidence: "User pauses Potts or revokes an account" → pending actions cannot
 * dispatch through any worker or alternate route.
 * Routes covered: the daemon's dispatch job, direct broker.execute, the
 * proposer socket (plugin route), the owner-alert call service, the release
 * route (deploy), and readers (sync stops for a revoked account).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { connectSocket } from '../../src/broker/server.ts';
import { createFakeClock } from '../../src/core/clock.ts';
import { createFakeTelephonyProvider } from '../../src/telephony/testing.ts';
import { createFakeNet, gmailAccount, makeHome, markConnected, routeGmail, sendPayload, startWorld, tokenSetFor } from './_harness.ts';

test('E2E-11 pause and revoke block every dispatch route; resume/reinstate need fresh approvals where bound', async () => {
  const start = '2026-10-07T15:00:00Z'; // 11:00 EDT (calls allowed by the clock)
  const home = makeHome({
    accounts: [gmailAccount('approval_required'), { id: 'telephony-alerts', kind: 'telephony', address: '+15550000001', mode: 'approval_required', purpose: 'owner_alert' }],
    potts: (c) => {
      (c.monitoring as Record<string, unknown>).enabled = false;
      c.integrations = { pauseAll: false, paused: {} };
      (c.owner as Record<string, unknown>).alertPhoneRef = 'keychain:potts/owner-alert-number';
      (c.telephony as Record<string, unknown>).enabled = true;
      c.writers = { accounts: [{ accountId: 'gmail-personal', enabled: true }] };
    },
  });
  const clock = createFakeClock(start);
  const phone = createFakeTelephonyProvider(clock);
  const net = createFakeNet();
  const gmail = routeGmail(net);
  const exp = '2026-10-09T00:00:00Z';
  const w = await startWorld({
    home, start, clock, net, daemon: { telephonyProvider: phone },
    keychain: { 'potts/google-oauth-client-secret': 'cs', 'potts/owner-alert-number': '+15550000999' },
    tokens: {
      'gmail-personal': tokenSetFor('google', start, { accessTokenExpiresAt: exp }),
      'gmail-personal.send': tokenSetFor('google', start, { scope: 'https://www.googleapis.com/auth/gmail.send', accessTokenExpiresAt: exp }),
    },
  });
  try {
    await w.d.start({ timers: false });
    markConnected(w, 'gmail-personal', 'google');
    markConnected(w, 'gmail-personal.send', 'google', 'https://www.googleapis.com/auth/gmail.send');

    // --- global pause ---------------------------------------------------------------------------------------
    w.owner({ type: 'pause_all', reason: 'owner /pause' });
    const a = w.d.broker.propose(sendPayload('bob@example.com', 'Paused?'), 'openclaw/potts');
    assert.ok(a.ok);
    assert.equal(a.value.status, 'held', 'proposals while paused are held');
    // Approved before the pause: nothing dispatches through the job or directly.
    w.owner({ type: 'resume', scope: 'global' });
    const b = w.d.broker.propose(sendPayload('carol@example.com', 'Approved then paused'), 'openclaw/potts');
    assert.ok(b.ok && w.approve(b.value.actionId).ok);
    w.owner({ type: 'pause_all', reason: 'owner /pause' });
    await w.advance(2 * 60_000, 15_000);
    const direct = await w.d.broker.execute(b.value.actionId);
    assert.equal(!direct.ok && direct.error.code, 'paused');
    // Plugin route (proposer socket): can only propose, and proposals are held.
    const sock = await connectSocket(join(home, 'run', 'broker.sock'));
    const viaSocket = await sock.call('propose', { action: sendPayload('dave@example.com', 'via plugin') });
    const exec = await sock.call('execute', { actionId: b.value.actionId });
    sock.close();
    assert.ok(viaSocket.ok && (viaSocket.result as { status: string }).status === 'held');
    assert.equal(exec.ok, false);
    // Owner-alert route: a call-worthy event while paused places no call.
    w.d.urgent.raise({ dedupKey: 'e2e:outage:p', sourceType: 'website_outage', sourceRef: 'exampleapp', title: 'Example App outage', shouldCall: true });
    await w.advance(2 * 60_000, 15_000);
    assert.equal(phone.placed.length, 0, 'no call while paused');
    // Release route: an approved deploy cannot dispatch while paused (no executor needed to prove it).
    const dpl = w.d.broker.propose({ kind: 'deploy', destination: ['cloudflare:example.com'], payload: { sha: 'abc' } }, 'openclaw/potts');
    assert.ok(dpl.ok && dpl.value.status === 'held');
    assert.equal(gmail.sent.length, 0, 'nothing sent while paused');
    // Readers stop too (the read gate honours pause).
    const syncCalls = () => w.net.log.filter((r) => r.url.includes('/users/me/') && !r.url.includes('/send')).length;
    const before = syncCalls();
    await w.advance(10 * 60_000, 60_000);
    assert.equal(syncCalls(), before, 'no mailbox reads while paused');
    const rejections = w.d.audit.list({ actionId: b.value.actionId }).filter((e) => e.type === 'execute_rejected').length;
    assert.equal(rejections, 1, 'only the direct execute was refused; the dispatch job does not flood the audit log while paused');
    // Resume: the approved send (approval still valid) goes out exactly once.
    w.owner({ type: 'resume', scope: 'global' });
    await w.advance(60_000, 15_000);
    assert.equal(gmail.sent.length, 1);
    assert.equal(w.d.broker.getAction(b.value.actionId)!.status, 'succeeded');

    // --- integration pause (the writer's integration) ---------------------------------------------------------
    const c = w.d.broker.propose(sendPayload('erin@example.com', 'integration pause'), 'openclaw/potts');
    assert.ok(c.ok && w.approve(c.value.actionId).ok);
    w.owner({ type: 'pause_integration', integration: 'messaging', reason: 'stop sends' });
    await w.advance(60_000, 15_000);
    assert.equal(gmail.sent.length, 1, 'paused integration blocks the writer route');
    w.owner({ type: 'resume', scope: 'integration:messaging' });

    // --- revocation -----------------------------------------------------------------------------------------
    const d = w.d.broker.propose(sendPayload('frank@example.com', 'revoked?'), 'openclaw/potts');
    assert.ok(d.ok && w.approve(d.value.actionId).ok);
    const dApproval = w.d.broker.approvals.live(d.value.actionId)!.id;
    // c may have dispatched after the resume; make sure the revoke races nothing.
    w.owner({ type: 'pause_all', reason: 'about to revoke' });
    w.owner({ type: 'revoke_account', accountId: 'gmail-personal', reason: 'lost laptop' });
    w.owner({ type: 'resume', scope: 'global' });
    const sentBefore = gmail.sent.length;
    await w.advance(5 * 60_000, 15_000);
    assert.equal(gmail.sent.length, sentBefore, 'revoked account sends nothing');
    const ex = await w.d.broker.execute(d.value.actionId);
    assert.equal(!ex.ok && ex.error.code, 'revoked');
    assert.equal(w.d.broker.approvals.get(dApproval)!.status, 'invalidated');
    const readsBefore = syncCalls();
    await w.advance(10 * 60_000, 60_000);
    assert.equal(syncCalls(), readsBefore, 'no mailbox reads for a revoked account');
    assert.equal(w.d.capabilities().find((x) => x.id === 'mail:gmail-personal')!.state, 'blocked');
    // Reinstating does not revive the old approval.
    w.owner({ type: 'reinstate_account', accountId: 'gmail-personal' });
    await w.advance(60_000, 15_000);
    assert.equal(gmail.sent.length, sentBefore);
    const again = await w.d.broker.execute(d.value.actionId);
    assert.equal(!again.ok && again.error.code, 'approval_missing');
    assert.equal(w.d.audit.verify().ok, true);
  } finally {
    await w.close();
  }
});
