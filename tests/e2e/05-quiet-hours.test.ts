/**
 * Evidence: "Event occurs at 23:01 or a retry crosses 23:00" → no owner
 * notification (message or call) until the allowed window (08:00 Toronto).
 * Real wiring: urgent events → outbox + owner-alert service → broker
 * (hooks.ownerAlert) → owner-alert executor with a fake telephony provider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeTelephonyProvider } from '../../src/telephony/testing.ts';
import { createFakeClock } from '../../src/core/clock.ts';
import { isQuietAt, DEFAULT_QUIET_HOURS } from '../../src/notifications/quiet-hours.ts';
import { makeHome, startWorld } from './_harness.ts';

const telephonyHome = () =>
  makeHome({
    accounts: [{ id: 'telephony-alerts', kind: 'telephony', address: '+15550000001', mode: 'approval_required', purpose: 'owner_alert' }],
    potts: (c) => {
      (c.monitoring as Record<string, unknown>).enabled = false;
      (c.owner as Record<string, unknown>).alertPhoneRef = 'keychain:potts/owner-alert-number';
      c.integrations = { pauseAll: false, paused: {} };
      (c.telephony as Record<string, unknown>).enabled = true;
    },
  });

test('E2E-05 event at 23:01 and a retry crossing 23:00: nothing reaches the owner until 08:00', async () => {
  const home = telephonyHome();
  const start = '2026-10-08T02:50:00Z'; // 22:50 EDT, 7 Oct
  const clock = createFakeClock(start);
  const provider = createFakeTelephonyProvider(clock);
  const w = await startWorld({ home, start, clock, keychain: { 'potts/owner-alert-number': '+15550000999' }, daemon: { telephonyProvider: provider } });
  try {
    assert.ok(w.d.runtime().executors.some((e) => e.startsWith('owner-alert-call')), JSON.stringify(w.d.runtime().problems));
    // 22:52 outage confirmed: message now, call now (outside quiet hours).
    await w.until('2026-10-08T02:52:00Z');
    const ev1 = w.d.urgent.raise({ dedupKey: 'e2e:outage:1', sourceType: 'website_outage', sourceRef: 'exampleapp', title: 'Example App outage (http_5xx)', shouldCall: true }).event.id;
    const callTimes = () => w.d.telephonyStore.calls(ev1).map((c) => c.createdAt);
    await w.advance(60_000, 15_000);
    assert.equal(w.channel.sent.filter((m) => m.type === 'text').length, 1, 'urgent message at 22:52');
    assert.equal(provider.placed.length, 1, 'first call at 22:52');
    // Retry 5 minutes later (22:57) is still before 23:00.
    await w.until('2026-10-08T02:58:00Z', 15_000);
    assert.equal(provider.placed.length, 2, 'second attempt at 22:57');
    // The third attempt would be due at 23:02 → held by quiet hours (proposal, dispatch and executor checks).
    await w.until('2026-10-08T03:01:00Z', 15_000); // 23:01
    const ev2 = w.d.urgent.raise({ dedupKey: 'e2e:interview:1', sourceType: 'interview_invitation', sourceRef: 'gmail-personal:m9', title: 'Interview invitation', shouldCall: true }).event.id;
    const msgsAt2301 = w.channel.sent.length;
    // Walk through the whole night: no message, no call.
    await w.until('2026-10-08T11:59:30Z', 5 * 60_000); // 07:59:30
    for (const p of provider.placed) assert.equal(isQuietAt(Date.parse(p.at), DEFAULT_QUIET_HOURS), false, `call placed during quiet hours at ${p.at}`);
    assert.equal(provider.placed.length, 2, 'no call between 23:00 and 08:00');
    assert.equal(w.channel.sent.length, msgsAt2301, 'no message between 23:00 and 08:00');
    assert.equal(w.d.telephonyStore.calls(ev2).length, 0);
    // 08:00: both events are still open and re-validated → message and calls are allowed now.
    await w.until('2026-10-08T12:02:00Z', 15_000);
    assert.ok(w.channel.sent.length > msgsAt2301, 'held messages delivered at 08:00');
    assert.equal(callTimes().length, 3, 'third attempt for the first event only after 08:00');
    assert.ok(Date.parse(callTimes()[2]!) >= Date.parse('2026-10-08T12:00:00Z'));
    assert.equal(w.d.telephonyStore.calls(ev2).length, 1);
    assert.ok(Date.parse(w.d.telephonyStore.calls(ev2)[0]!.createdAt) >= Date.parse('2026-10-08T12:00:00Z'));
    // Limit: never more than 3 attempts for one incident.
    await w.advance(30 * 60_000, 60_000);
    assert.equal(callTimes().length, 3);
  } finally {
    await w.close();
  }
});
