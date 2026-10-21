/**
 * Evidence: "Overnight outage recovers before 08:00" → recovery appears in the
 * briefing; no obsolete outage call (and no 08:00 message).
 * Real wiring: site monitor (fake site) → incidents → urgent events → outbox
 * + owner-alert service (fake telephony) → 09:00 briefing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClock } from '../../src/core/clock.ts';
import { createFakeTelephonyProvider } from '../../src/telephony/testing.ts';
import { createFakeNet, makeHome, routeSite, startWorld } from './_harness.ts';

test('E2E-06 outage 01:00–01:35 recovers before 08:00 → briefing reports it, no call, no 08:00 message', async () => {
  const home = makeHome({
    accounts: [{ id: 'telephony-alerts', kind: 'telephony', address: '+15550000001', mode: 'approval_required', purpose: 'owner_alert' }],
    potts: (c) => {
      (c.owner as Record<string, unknown>).alertPhoneRef = 'keychain:potts/owner-alert-number';
      c.integrations = { pauseAll: false, paused: {} };
      (c.telephony as Record<string, unknown>).enabled = true;
    },
  });
  const start = '2026-10-07T04:30:00Z'; // 00:30 EDT
  const clock = createFakeClock(start);
  const provider = createFakeTelephonyProvider(clock);
  const net = createFakeNet();
  const site = routeSite(net);
  const w = await startWorld({ home, start, clock, net, keychain: { 'potts/owner-alert-number': '+15550000999' }, daemon: { telephonyProvider: provider } });
  try {
    await w.until('2026-10-07T05:00:00Z');
    site.home = 503;
    site.health = 503;
    await w.until('2026-10-07T05:35:00Z');
    const open = w.d.monitor!.incidents.listUnresolved();
    assert.equal(open.length, 1, 'outage confirmed after 10 minutes');
    const evId = open[0]!.urgentEventId!;
    assert.ok(w.d.telephonyStore.incident(evId), 'an alert incident was registered');
    assert.equal(provider.placed.length, 0, 'quiet hours: no call');
    site.home = 200;
    site.health = 200;
    await w.until('2026-10-07T06:00:00Z');
    assert.equal(w.d.monitor!.incidents.listUnresolved().length, 0, 'recovered');
    assert.notEqual(w.d.telephonyStore.incident(evId)!.status, 'active', 'alert incident closed on recovery');
    await w.until('2026-10-07T12:30:00Z'); // 08:30
    assert.equal(provider.placed.length, 0, 'no obsolete outage call at 08:00');
    assert.equal(w.channel.sent.length, 0, 'no stale outage message at 08:00');
    await w.until('2026-10-07T13:01:00Z'); // 09:01
    const texts = w.channel.sent.filter((m) => m.type === 'text').map((m) => (m as { text: string }).text);
    assert.equal(texts.length, 1, 'exactly one message: the morning briefing');
    assert.match(texts[0]!, /^Hey,/);
    assert.match(texts[0]!, /Example App was unavailable from/);
    assert.equal(texts[0]!.match(/Example App was unavailable/g)?.length, 1);
    assert.doesNotMatch(texts[0]!, /http_5xx|Ref inc_|Resolved:|Local monitor only/);
    assert.equal(provider.placed.length, 0);
  } finally {
    await w.close();
  }
});
