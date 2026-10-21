import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestHarness } from '../../src/broker/testing.ts';
import { createUrgentEventStore, type UrgentEventStore } from '../../src/notifications/urgent.ts';
import { createBrokerAlertAttemptSource, createOwnerAlertHook, evaluateOwnerAlert, shouldCallOwner } from '../../src/notifications/owner-alert.ts';
import { DEFAULT_QUIET_HOURS } from '../../src/notifications/quiet-hours.ts';
import type { ActionView, HookVerdict } from '../../src/policy/decide.ts';
import type { LoadedPolicy } from '../../src/policy/document.ts';

const quiet = DEFAULT_QUIET_HOURS;

test('pure policy: verification, quiet hours, ack/resolve, attempts and interval', () => {
  const base = {
    nowMs: Date.parse('2026-10-07T14:00:00Z'), // 10:00 EDT
    quiet,
    triggerId: 'urg_1',
    trigger: { status: 'open' as const, shouldCall: true },
    attempts: { count: 0, lastAttemptMs: null },
    maxAttempts: 3,
    retryIntervalSeconds: 300,
  };
  assert.equal(evaluateOwnerAlert(base).outcome, 'allow');
  assert.equal(evaluateOwnerAlert({ ...base, triggerId: null }).outcome, 'deny');
  assert.equal(evaluateOwnerAlert({ ...base, trigger: null }).outcome, 'deny');
  assert.equal(evaluateOwnerAlert({ ...base, trigger: { status: 'acknowledged', shouldCall: true } }).outcome, 'deny');
  assert.equal(evaluateOwnerAlert({ ...base, trigger: { status: 'resolved', shouldCall: true } }).outcome, 'deny');
  assert.equal(evaluateOwnerAlert({ ...base, trigger: { status: 'open', shouldCall: false } }).outcome, 'deny');
  const night = evaluateOwnerAlert({ ...base, nowMs: Date.parse('2026-10-07T03:30:00Z') });
  assert.equal(night.outcome, 'hold');
  assert.equal(night.notBeforeMs, Date.parse('2026-10-07T12:00:00Z'));
  assert.equal(evaluateOwnerAlert({ ...base, attempts: { count: 3, lastAttemptMs: base.nowMs - 3600_000 } }).outcome, 'deny');
  assert.equal(evaluateOwnerAlert({ ...base, attempts: { count: 1, lastAttemptMs: base.nowMs - 299_000 } }).outcome, 'hold');
  assert.equal(evaluateOwnerAlert({ ...base, attempts: { count: 1, lastAttemptMs: base.nowMs - 300_000 } }).outcome, 'allow');
  // last attempt 22:58, now 08:00 next day: allowed (quiet hours over)
  assert.equal(
    evaluateOwnerAlert({ ...base, nowMs: Date.parse('2026-10-07T12:00:00Z'), attempts: { count: 1, lastAttemptMs: Date.parse('2026-10-07T02:58:00Z') } }).outcome,
    'allow',
  );
});

function harness() {
  let hook: ((a: ActionView, p: LoadedPolicy) => HookVerdict) | null = null;
  const h = createTestHarness({ hooks: { ownerAlert: (a, p) => (hook ? hook(a, p) : { outcome: 'hold', reasons: ['not wired'] }) } });
  const urgent: UrgentEventStore = createUrgentEventStore(h.db, h.clock);
  const attempts = createBrokerAlertAttemptSource(h.db);
  hook = createOwnerAlertHook({ clock: h.clock, quiet, urgent, attempts });
  const call = (eventId: string) =>
    h.broker.propose({ kind: 'call_owner_alert', destination: ['owner'], payload: { trigger: { type: 'urgent_event', id: eventId } } }, 'potts:telephony');
  return { h, urgent, attempts, call };
}

test('broker integration: 3 attempts max, 5 minutes apart; restart cannot reset the count', async () => {
  const { h, urgent, call } = harness();
  h.clock.set('2026-10-07T14:00:00Z');
  const ev = urgent.raise({ dedupKey: 'incident:x', sourceType: 'website_outage', sourceRef: 'inc_x', title: 'down', shouldCall: true }).event;
  const placed: string[] = [];
  for (let i = 0; i < 6; i++) {
    const p = call(ev.id);
    assert.ok(p.ok);
    if (p.value.decision === 'allow') {
      const e = await h.broker.execute(p.value.actionId);
      assert.ok(e.ok, JSON.stringify(e));
      placed.push(h.clock.nowIso());
    }
    h.clock.advanceMs(i === 0 ? 120_000 : 180_000); // +2m (too soon), then +3m steps
  }
  assert.equal(placed.length, 3);
  // Restart on the same DB: the count comes from the broker's dispatch records.
  const h2 = h.reopen();
  const hook2 = createOwnerAlertHook({ clock: h2.clock, quiet, urgent: createUrgentEventStore(h2.db, h2.clock), attempts: createBrokerAlertAttemptSource(h2.db) });
  h2.clock.advanceMs(3600_000);
  const v = hook2({ kind: 'call_owner_alert', actor: 'x', accountId: null, integration: null, destination: ['owner'], payload: { trigger: { type: 'urgent_event', id: ev.id } }, scope: null }, h2.policy.current);
  assert.equal(v.outcome, 'deny');
  assert.match(v.reasons[0]!, /retry limit/);
});

test('acknowledged incident suppresses the 08:00 call; a call proposed before 23:00 cannot dispatch after 23:00', async () => {
  const { h, urgent, call } = harness();
  h.clock.set('2026-10-07T06:00:00Z'); // 02:00 EDT
  const ev = urgent.raise({ dedupKey: 'incident:y', sourceType: 'website_outage', sourceRef: 'inc_y', title: 'down', shouldCall: true }).event;
  const night = call(ev.id);
  assert.ok(night.ok);
  assert.equal(night.value.decision, 'hold');
  urgent.acknowledge(ev.id, 'owner:telegram'); // owner saw it at 03:00
  h.clock.set('2026-10-07T12:00:00Z'); // 08:00
  const morning = call(ev.id);
  assert.ok(morning.ok);
  assert.equal(morning.value.decision, 'deny');
  assert.equal(shouldCallOwner({ clock: h.clock, quiet, urgent, attempts: createBrokerAlertAttemptSource(h.db), policy: h.policy.current }, ev.id).outcome, 'deny');

  // Retry crossing 23:00: allowed at 22:59:50 at proposal, re-checked at dispatch at 23:00:10.
  const ev2 = urgent.raise({ dedupKey: 'task:z', sourceType: 'task_due', sourceRef: 'z', title: 'due', shouldCall: true }).event;
  h.clock.set('2026-10-08T02:59:50Z');
  const late = call(ev2.id);
  assert.ok(late.ok);
  assert.equal(late.value.decision, 'allow');
  h.clock.set('2026-10-08T03:00:10Z');
  const ex = await h.broker.execute(late.value.actionId);
  assert.equal(ex.ok, false);
  if (!ex.ok) assert.equal(ex.error.code, 'held');
  assert.equal(h.provider.countFor(late.value.actionId), 0);
});
