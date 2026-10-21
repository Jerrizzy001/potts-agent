import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, JobError, type JobRunContext } from '../../src/jobs/scheduler.ts';
import { makeEnv } from './_helpers.ts';

const TZ = 'America/Toronto';

function dailyDef(time = '09:00', graceMs = 2 * 3600_000) {
  return { id: 'briefing:morning', schedule: { type: 'daily' as const, time, timezone: TZ }, missed: { type: 'late_within' as const, graceMs } };
}

async function runSpan(env: ReturnType<typeof makeEnv>, sched: ReturnType<typeof createScheduler>, untilIso: string, stepMs = 60_000) {
  const end = Date.parse(untilIso);
  while (env.clock.nowMs() < end) {
    env.clock.advanceMs(stepMs);
    await sched.tick();
  }
}

test('DST fall back (2026-11-01): a 09:00 job fires once at 09:00 local each day', async () => {
  const env = makeEnv('2026-10-30T20:00:00Z');
  const s = createScheduler({ db: env.db, clock: env.clock });
  const runs: string[] = [];
  s.register(dailyDef(), async (ctx) => {
    runs.push(`${env.clock.nowIso()} ${ctx.slotKey} late=${ctx.late}`);
  });
  await runSpan(env, s, '2026-11-03T00:00:00Z');
  assert.deepEqual(runs, [
    '2026-10-31T13:00:00.000Z 2026-10-31 late=false',
    '2026-11-01T14:00:00.000Z 2026-11-01 late=false',
    '2026-11-02T14:00:00.000Z 2026-11-02 late=false',
  ]);
});

test('DST spring forward (2027-03-14): 09:00 fires once each day; a 02:30 job fires once at 03:30', async () => {
  const env = makeEnv('2027-03-12T20:00:00Z');
  const s = createScheduler({ db: env.db, clock: env.clock });
  const runs: string[] = [];
  const gap: string[] = [];
  s.register(dailyDef(), async () => void runs.push(env.clock.nowIso()));
  s.register({ id: 'gap-job', schedule: { type: 'daily', time: '02:30', timezone: TZ } }, async () => void gap.push(env.clock.nowIso()));
  await runSpan(env, s, '2027-03-16T00:00:00Z');
  assert.deepEqual(runs, ['2027-03-13T14:00:00.000Z', '2027-03-14T13:00:00.000Z', '2027-03-15T13:00:00.000Z']);
  assert.deepEqual(gap, ['2027-03-13T07:30:00.000Z', '2027-03-14T07:30:00.000Z', '2027-03-15T06:30:00.000Z']);
});

test('ambiguous 01:30 on fall-back day fires once', async () => {
  const env = makeEnv('2026-10-31T20:00:00Z');
  const s = createScheduler({ db: env.db, clock: env.clock });
  const runs: string[] = [];
  s.register({ id: 'early', schedule: { type: 'daily', time: '01:30', timezone: TZ } }, async () => void runs.push(env.clock.nowIso()));
  await runSpan(env, s, '2026-11-01T20:00:00Z');
  assert.deepEqual(runs, ['2026-11-01T05:30:00.000Z']);
});

test('sleep/wake: briefing missed by < grace runs once marked late; a second tick does nothing', async () => {
  const env = makeEnv('2026-10-07T12:00:00Z'); // 08:00 EDT
  const s = createScheduler({ db: env.db, clock: env.clock });
  const runs: JobRunContext[] = [];
  s.register(dailyDef(), async (ctx) => void runs.push(ctx));
  await s.tick();
  env.clock.set('2026-10-07T14:30:00Z'); // wake at 10:30
  await s.tick();
  await s.tick();
  env.clock.advanceMs(60_000);
  await s.tick();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.late, true);
  assert.equal(runs[0]!.slotKey, '2026-10-07');
  assert.equal(runs[0]!.lateByMs, 90 * 60_000);
  assert.equal(s.state('briefing:morning')!.nextRunAt, '2026-10-08T13:00:00.000Z');
});

test('sleep/wake across several days: no backlog; older slots are folded into the one run', async () => {
  const env = makeEnv('2026-10-05T12:00:00Z'); // Mon 08:00
  const s = createScheduler({ db: env.db, clock: env.clock });
  const runs: JobRunContext[] = [];
  s.register(dailyDef(), async (ctx) => void runs.push(ctx));
  await s.tick();
  env.clock.set('2026-10-07T14:00:00Z'); // Wed 10:00
  const rep = await s.tick();
  await s.tick();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.slotKey, '2026-10-07');
  assert.deepEqual(runs[0]!.folded, ['2026-10-05', '2026-10-06']);
  assert.equal(rep.ran.length, 1);
});

test('missed beyond grace: folded into the next day, not delivered stale', async () => {
  const env = makeEnv('2026-10-07T12:00:00Z');
  const s = createScheduler({ db: env.db, clock: env.clock });
  const runs: JobRunContext[] = [];
  s.register(dailyDef('09:00', 2 * 3600_000), async (ctx) => void runs.push(ctx));
  env.clock.set('2026-10-07T17:00:00Z'); // 13:00, 4h late
  const rep = await s.tick();
  assert.equal(runs.length, 0);
  assert.deepEqual(rep.folded, [{ jobId: 'briefing:morning', slotKeys: ['2026-10-07'] }]);
  env.clock.set('2026-10-08T13:00:00Z');
  await s.tick();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.late, false);
  assert.deepEqual(runs[0]!.folded, ['2026-10-07']);
});

test('restart mid-run: lease blocks a second process; after lease expiry the slot is retried once and the stale run cannot complete it', async () => {
  const env = makeEnv('2026-10-07T12:59:00Z');
  const effects = new Set<string>(); // stands in for the outbox dedup key
  let releaseA!: () => void;
  const a = createScheduler({ db: env.db, clock: env.clock, instanceId: 'proc-A' });
  const def = { ...dailyDef(), leaseMs: 120_000 };
  let calls = 0;
  a.register(def, async (ctx) => {
    calls++;
    await new Promise<void>((r) => (releaseA = r));
    effects.add(`briefing:${ctx.slotKey}`);
  });
  env.clock.set('2026-10-07T13:00:00Z');
  const pA = a.tick(); // A claims and hangs ("process freezes / dies")
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);

  // "Restart": a new process (new connection, new instance) with the same job.
  const db2 = env.reopen();
  const b = createScheduler({ db: db2, clock: env.clock, instanceId: 'proc-B' });
  const bRuns: string[] = [];
  b.register(def, async (ctx) => {
    bRuns.push(ctx.slotKey);
    effects.add(`briefing:${ctx.slotKey}`);
  });
  const r1 = await b.tick();
  assert.deepEqual(r1.skippedLeased, ['briefing:morning']);
  assert.equal(bRuns.length, 0);

  env.clock.advanceMs(121_000); // lease expired
  const r2 = await b.tick();
  assert.equal(r2.ran.length, 1);
  assert.equal(r2.ran[0]!.attempt, 2);
  assert.deepEqual(bRuns, ['2026-10-07']);

  releaseA(); // the stale run finally returns
  const repA = await pA;
  assert.equal(repA.ran[0]!.status, 'lease_lost');
  await b.tick();
  env.clock.advanceMs(3600_000);
  await b.tick();
  assert.equal(effects.size, 1);
  const runs = b.runs('briefing:morning');
  assert.deepEqual(runs.map((r) => `${r.attempt}:${r.status}`).sort(), ['1:lease_lost', '2:succeeded']);
  const slot = db2.prepare(`SELECT status, attempts FROM sched_slots WHERE job_id = 'briefing:morning' AND slot_key = '2026-10-07'`).get() as { status: string; attempts: number };
  assert.deepEqual({ ...slot }, { status: 'succeeded', attempts: 2 });
});

test('startup recover(assumeSoleOwner) releases a dead lease immediately; completed slots never rerun after restart', async () => {
  const env = makeEnv('2026-10-07T12:59:00Z');
  const a = createScheduler({ db: env.db, clock: env.clock, instanceId: 'old' });
  a.register(dailyDef(), () => new Promise(() => {}));
  env.clock.set('2026-10-07T13:00:00Z');
  void a.tick();
  await new Promise((r) => setImmediate(r));
  const b = createScheduler({ db: env.reopen(), clock: env.clock, instanceId: 'new' });
  const runs: number[] = [];
  b.register(dailyDef(), async (ctx) => void runs.push(ctx.attempt));
  assert.equal(b.recover({ assumeSoleOwner: true }), 1);
  await b.tick();
  assert.deepEqual(runs, [2]);
  // Another restart at the same instant: slot already succeeded, nothing runs.
  const c = createScheduler({ db: env.reopen(), clock: env.clock, instanceId: 'newer' });
  c.register(dailyDef(), async () => void runs.push(-1));
  c.recover({ assumeSoleOwner: true });
  await c.tick();
  assert.deepEqual(runs, [2]);
});

test('two schedulers ticking at once: only one runs the job', async () => {
  const env = makeEnv('2026-10-07T13:00:00Z');
  const n: string[] = [];
  const a = createScheduler({ db: env.db, clock: env.clock, instanceId: 'A' });
  const b = createScheduler({ db: env.reopen(), clock: env.clock, instanceId: 'B' });
  const def = { id: 'monitor:websites', schedule: { type: 'interval' as const, everyMs: 60_000 } };
  a.register(def, async () => void n.push('A'));
  b.register(def, async () => void n.push('B'));
  await Promise.all([a.tick(), b.tick()]);
  assert.equal(n.length, 1);
});

test('interval job after a long sleep runs once (no backlog) and keeps its cadence', async () => {
  const env = makeEnv('2026-10-07T13:00:00Z');
  const s = createScheduler({ db: env.db, clock: env.clock });
  const runs: string[] = [];
  s.register({ id: 'monitor:websites', schedule: { type: 'interval', everyMs: 60_000 } }, async () => void runs.push(env.clock.nowIso()));
  await s.tick();
  env.clock.advanceMs(6 * 3600_000);
  await s.tick();
  await s.tick();
  env.clock.advanceMs(59_000);
  await s.tick();
  env.clock.advanceMs(1_000);
  await s.tick();
  assert.deepEqual(runs, ['2026-10-07T13:00:00.000Z', '2026-10-07T19:00:00.000Z', '2026-10-07T19:01:00.000Z']);
});

test('backoff with jitter on failures; Retry-After and provider limits respected', async () => {
  const env = makeEnv('2026-10-07T13:00:00Z');
  const s = createScheduler({ db: env.db, clock: env.clock, random: () => 0.5 });
  let mode: 'fail' | 'limit' | 'slow' | 'ok' = 'fail';
  s.register(
    { id: 'sync:gmail', schedule: { type: 'interval', everyMs: 5 * 60_000 }, backoff: { baseMs: 60_000, maxMs: 3600_000, jitter: 0.2 } },
    async () => {
      if (mode === 'fail') throw new Error('provider 500');
      if (mode === 'limit') throw new JobError('429', { retryAfterMs: 2 * 3600_000 });
      if (mode === 'slow') return { nextDelayMs: 20 * 60_000 };
      return undefined;
    },
  );
  const next = () => Date.parse(s.state('sync:gmail')!.nextRunAt) - env.clock.nowMs();
  await s.tick();
  assert.equal(next(), 5 * 60_000); // max(interval, 60s*0.9)
  for (let i = 0; i < 4; i++) {
    env.clock.advanceMs(next());
    await s.tick();
  }
  // failures 5 → 60s * 2^4 * (1 - 0.2*0.5) = 864s
  assert.equal(next(), 864_000);
  mode = 'limit';
  env.clock.advanceMs(next());
  await s.tick();
  assert.equal(next(), 2 * 3600_000);
  mode = 'slow';
  env.clock.advanceMs(next());
  await s.tick();
  assert.equal(next(), 20 * 60_000);
  assert.equal(s.state('sync:gmail')!.consecutiveFailures, 0);
});

test('daily job failure retries within grace, then succeeds exactly once', async () => {
  const env = makeEnv('2026-10-07T12:59:00Z');
  const s = createScheduler({ db: env.db, clock: env.clock, random: () => 0 });
  let fails = 2;
  const ok: number[] = [];
  s.register({ ...dailyDef(), backoff: { baseMs: 60_000, maxMs: 600_000, jitter: 0 } }, async (ctx) => {
    if (fails-- > 0) throw new Error('model busy');
    ok.push(ctx.attempt);
  });
  env.clock.set('2026-10-07T13:00:00Z');
  await s.tick();
  env.clock.advanceMs(60_000);
  await s.tick();
  env.clock.advanceMs(120_000);
  await s.tick();
  env.clock.advanceMs(3600_000);
  await s.tick();
  assert.deepEqual(ok, [3]);
  assert.equal(s.state('briefing:morning')!.nextRunAt, '2026-10-08T13:00:00.000Z');
});
