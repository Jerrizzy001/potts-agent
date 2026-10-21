import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../../src/jobs/scheduler.ts';
import { registerStandardJobs } from '../../src/jobs/standard.ts';
import { createBriefingComposer } from '../../src/notifications/briefings.ts';
import { createBrokerAlertAttemptSource, shouldCallOwner } from '../../src/notifications/owner-alert.ts';
import { DEFAULT_QUIET_HOURS } from '../../src/notifications/quiet-hours.ts';
import { buildPolicy, DEFAULT_POLICY } from '../../src/policy/document.ts';
import { setupMonitor } from './_site.ts';

const TZ = 'America/Toronto';

function world(start: string) {
  const s = setupMonitor(start);
  const composer = createBriefingComposer({ db: s.env.db, clock: s.env.clock, timezone: TZ, providers: {}, outbox: s.outbox, urgent: s.urgent, monitor: s.monitor });
  const sched = createScheduler({ db: s.env.db, clock: s.env.clock, random: () => 0.5 });
  registerStandardJobs(sched, {
    timezone: TZ,
    briefings: [
      { id: 'morning', time: '09:00' },
      { id: 'evening', time: '18:00' },
      { id: 'night', time: '21:00' },
    ],
    composer,
    outbox: s.outbox,
    monitor: s.monitor,
  });
  const policy = buildPolicy(DEFAULT_POLICY);
  if (!policy.ok) throw policy.error;
  // The broker tables exist (foundation migration), so the real attempt source works.
  const alertOpts = { clock: s.env.clock, quiet: DEFAULT_QUIET_HOURS, urgent: s.urgent, attempts: createBrokerAlertAttemptSource(s.env.db), policy: policy.value };
  async function until(iso: string, step = 30_000) {
    const end = Date.parse(iso);
    while (s.env.clock.nowMs() < end) {
      s.env.clock.advanceMs(step);
      await sched.tick();
    }
  }
  return { ...s, sched, until, alertOpts, composer };
}

test('overnight outage that recovers before 08:00 → appears in the 09:00 briefing; no call, no message', async () => {
  const w = world('2026-10-07T04:30:00Z'); // 00:30 EDT
  await w.until('2026-10-07T05:00:00Z');
  w.st.home = 503;
  w.st.health = 503;
  await w.until('2026-10-07T05:35:00Z'); // 01:00–01:35 down
  const inc = w.monitor.incidents.listUnresolved();
  assert.equal(inc.length, 1);
  const evId = inc[0]!.urgentEventId!;
  assert.equal(shouldCallOwner(w.alertOpts, evId).outcome, 'hold'); // quiet hours
  w.st.home = 200;
  w.st.health = 200;
  await w.until('2026-10-07T06:00:00Z');
  assert.equal(w.monitor.incidents.listUnresolved().length, 0);
  await w.until('2026-10-07T12:00:30Z'); // 08:00:30
  assert.equal(w.channel.sent.length, 0); // nothing sent at 08:00
  assert.equal(shouldCallOwner(w.alertOpts, evId).outcome, 'deny'); // no stale call
  const opening = w.outbox.getByDedupKey(`urgent:incident:${inc[0]!.id}`)!;
  assert.equal(opening.status, 'dropped');
  const retainedDraft = await w.composer.compose('morning', 'inspect');
  await w.until('2026-10-07T13:01:00Z'); // 09:01
  assert.equal(w.channel.sent.length, 1);
  const brief = w.channel.sent[0]!.text;
  assert.match(brief, /^Hey, here’s what’s up this morning/);
  assert.match(brief, /Example App was unavailable from 2026-10-07 01:0\d to 2026-10-07 01:3\d\. It recovered after that\./);
  assert.equal(brief.match(/Example App was unavailable/g)?.length, 1, 'recovery is reported once');
  assert.doesNotMatch(brief, /http_5xx|Ref inc_|Resolved:|Local monitor only|Website status/);
  assert.ok(retainedDraft.sections.some(s => s.lines.some(l => l.includes('http_5xx'))), 'full cause evidence stays in structured sections');
});

test('acknowledged overnight incident suppresses the 08:00 message and call; briefing shows it as acknowledged', async () => {
  const w = world('2026-10-07T05:00:00Z'); // 01:00
  w.st.home = 'timeout';
  w.st.health = 'timeout';
  await w.until('2026-10-07T06:00:00Z');
  const inc = w.monitor.incidents.listUnresolved()[0]!;
  w.monitor.acknowledge(inc.id, 'owner:telegram'); // owner woke up and acknowledged
  assert.equal(w.urgent.get(inc.urgentEventId!)!.status, 'acknowledged');
  await w.until('2026-10-07T12:05:00Z');
  assert.equal(w.channel.sent.length, 0);
  assert.equal(shouldCallOwner(w.alertOpts, inc.urgentEventId!).outcome, 'deny');
  await w.until('2026-10-07T13:01:00Z');
  assert.equal(w.channel.sent.length, 1);
  assert.match(w.channel.sent[0]!.text, /Example App has been unavailable since 2026-10-07 01:00\. You’ve already seen this\./);
  assert.equal(w.monitor.incidents.listUnresolved().length, 1); // still one incident, not duplicated
});

test('unacknowledged outage still open at 08:00 → message delivered at 08:00 and call allowed', async () => {
  const w = world('2026-10-07T07:00:00Z'); // 03:00
  w.st.home = 502;
  await w.until('2026-10-07T12:00:30Z');
  const inc = w.monitor.incidents.listUnresolved()[0]!;
  assert.equal(w.channel.sent.length, 1);
  assert.equal(w.channel.sent[0]!.at, Date.parse('2026-10-07T12:00:00Z'));
  assert.equal(shouldCallOwner(w.alertOpts, inc.urgentEventId!).outcome, 'allow');
  const draft = await w.composer.compose('morning', 'inspect');
  assert.match(draft.text, /Example App has been unavailable/);
  assert.equal(draft.text.match(/Example App/g)?.length, 1, 'open incident is not repeated in urgent and website sections');
  assert.doesNotMatch(draft.text, /http_5xx/);
});
