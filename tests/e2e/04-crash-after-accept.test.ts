/**
 * Evidence: "Service crashes immediately after a provider accepts a send"
 * → reconciliation finds the original result; no automatic duplicate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeNet, gmailAccount, makeHome, markConnected, routeGmail, sendPayload, startWorld, tokenSetFor } from './_harness.ts';

const START = '2026-10-07T14:00:00Z';

test('E2E-04 crash right after Gmail accepted a send → restart marks it uncertain → reconcile finds it → never re-sent', async () => {
  const home = makeHome({
    accounts: [gmailAccount('approval_required')],
    potts: (c) => {
      (c.monitoring as Record<string, unknown>).enabled = false;
      c.writers = { accounts: [{ accountId: 'gmail-personal', enabled: true }] };
    },
  });
  const net = createFakeNet();
  const gmail = routeGmail(net);
  const w = await startWorld({
    home, start: START, net, keychain: { 'potts/google-oauth-client-secret': 'cs' },
    tokens: {
      'gmail-personal': tokenSetFor('google', START, { accessTokenExpiresAt: '2026-10-09T00:00:00Z' }),
      'gmail-personal.send': tokenSetFor('google', START, { scope: 'https://www.googleapis.com/auth/gmail.send', accessTokenExpiresAt: '2026-10-09T00:00:00Z' }),
    },
    daemon: { brokerTestHooks: { afterProviderAccept: () => { throw new Error('SIMULATED CRASH after provider accept'); } } },
  });
  try {
    markConnected(w, 'gmail-personal', 'google');
    markConnected(w, 'gmail-personal.send', 'google', 'https://www.googleapis.com/auth/gmail.send');
    const p = w.d.broker.propose(sendPayload('bob@example.com', 'Invoice attached'), 'openclaw/potts');
    assert.ok(p.ok);
    assert.ok(w.approve(p.value.actionId).ok);
    await assert.rejects(w.d.broker.execute(p.value.actionId), /SIMULATED CRASH/);
    assert.equal(gmail.sent.length, 1, 'the provider accepted the message');
    assert.equal(w.d.broker.dispatches(p.value.actionId)[0]!.state, 'dispatching', 'receipt never persisted');

    // Process dies; launchd restarts it (no test hooks this time).
    await w.restart({ brokerTestHooks: {} });
    const a = w.d.broker.getAction(p.value.actionId)!;
    assert.equal(a.status, 'uncertain', 'recover() marks the in-flight dispatch uncertain');
    // Nothing retries an uncertain dispatch: the dispatch job skips it and execute refuses.
    const ex = await w.d.broker.execute(p.value.actionId);
    assert.equal(!ex.ok && ex.error.code, 'uncertain_requires_reconcile');
    // The daemon's reconcile job (every 5 min) asks Gmail by Message-ID and finds the original.
    await w.advance(6 * 60_000, 30_000);
    const after = w.d.broker.getAction(p.value.actionId)!;
    assert.equal(after.status, 'succeeded');
    const ds = w.d.broker.dispatches(p.value.actionId);
    assert.equal(ds.length, 1);
    assert.equal(ds[0]!.state, 'reconciled_sent');
    assert.equal(ds[0]!.providerOperationId, `gmail:${gmail.sent[0]!.id}`);
    assert.equal(gmail.sent.length, 1, 'no duplicate send');
    await w.advance(30 * 60_000, 60_000);
    assert.equal(gmail.sent.length, 1, 'still no duplicate later');
    const types = w.d.audit.list({ actionId: p.value.actionId }).map((e) => e.type);
    assert.ok(types.includes('recovery') && types.includes('reconciliation'));
  } finally {
    await w.close();
  }
});
