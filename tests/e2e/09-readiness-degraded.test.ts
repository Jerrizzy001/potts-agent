/**
 * Evidence: "Website homepage is green but readiness fails" → a distinct
 * degraded-service report, with authentication failure (monitor credential)
 * distinguished from service failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN } from '../monitoring/_site.ts';
import { createFakeNet, makeHome, routeSite, startWorld } from './_harness.ts';

test('E2E-09 homepage/health 200 but readiness degraded → degraded incident; bad monitor token → monitor_auth, not an outage', async () => {
  const start = '2026-10-07T14:00:00Z'; // 10:00 EDT
  const home = makeHome({
    potts: (c) => {
      const site = ((c.monitoring as Record<string, unknown>).sites as Record<string, unknown>[])[0]!;
      site.readiness = { path: '/api/monitor', tokenRef: 'keychain:potts/exampleapp-monitor-token' };
    },
  });
  const net = createFakeNet();
  const st = routeSite(net);
  const w = await startWorld({ home, start, net, keychain: { 'potts/exampleapp-monitor-token': TOKEN } });
  try {
    await w.advance(5 * 60_000);
    assert.equal(w.d.monitor!.incidents.listUnresolved().length, 0);
    // Service failure behind a green homepage: /api/monitor reports degraded (503 + database down).
    st.readiness = 503;
    await w.advance(15 * 60_000);
    const open = w.d.monitor!.incidents.listUnresolved();
    assert.equal(open.length, 1);
    assert.equal(open[0]!.failureClass, 'degraded', 'reported as degraded service, not an outage');
    const cap = () => w.d.capabilities().find((c) => c.id === 'monitor:exampleapp')!;
    assert.match(cap().reason, /open: degraded/);
    const msgs = w.channel.sent.filter((m) => m.type === 'text').map((m) => (m as { text: string }).text);
    assert.ok(msgs.some((t) => /degraded/i.test(t)), `owner told about degraded service: ${msgs.join(' | ')}`);
    assert.ok(!msgs.some((t) => /\boutage\b/i.test(t) && !/degraded/i.test(t)), 'not reported as an outage');
    st.readiness = 200;
    await w.advance(10 * 60_000);
    assert.equal(w.d.monitor!.incidents.listUnresolved().length, 0, 'recovered');

    // Authentication failure: the monitor token is rotated on the site, Potts still has the old one (401).
    w.keychain.set('potts/exampleapp-monitor-token', 'stale-token-value-0000000000000000000000');
    await w.advance(15 * 60_000);
    const auth = w.d.monitor!.incidents.listUnresolved();
    assert.equal(auth.length, 1);
    assert.equal(auth[0]!.failureClass, 'monitor_auth', 'credential problem, distinguished from service failure');
    assert.match(cap().reason, /monitor credential failing \(not an outage\)/);
    // The site itself is fine: homepage and health stayed green throughout, so no outage incident exists.
    const all = w.d.db.prepare("SELECT failure_class FROM incidents ORDER BY opened_at").all() as { failure_class: string }[];
    assert.deepEqual(all.map((r) => r.failure_class), ['degraded', 'monitor_auth']);
  } finally {
    await w.close();
  }
});
