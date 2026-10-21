import { randomUUID } from 'node:crypto';
import type { Clock } from '../core/clock.ts';
import { canonicalJson, hashCanonical } from '../core/hash.ts';
import { newId } from '../core/ids.ts';
import { nullLogger, type Logger } from '../core/log.ts';
import { withTransaction, type Db } from '../store/db.ts';
import { assertTimezone, dailySlotKey, nextDailyOccurrence, parseHhmm } from './tz.ts';

/**
 * The single durable scheduler authority. Job state lives in SQLite
 * (sched_jobs / sched_slots / sched_runs). Guarantees:
 *  - each daily slot (job + local date) succeeds at most once (PK on sched_slots);
 *  - a lease prevents two runs of one job at the same time, across processes;
 *  - after sleep/wake or restart only the latest due slot is considered:
 *    older missed slots are "folded" (recorded as missed and handed to the next
 *    run), never replayed as a backlog;
 *  - failures back off exponentially with jitter; handlers may ask for a
 *    longer delay (provider Retry-After / rate limits).
 */

export type JobSchedule =
  | { type: 'daily'; time: string; timezone: string }
  | { type: 'interval'; everyMs: number; initialDelayMs?: number };

export type MissedPolicy =
  /** Daily: if the slot was missed by less than graceMs, run once marked late; otherwise fold into next. */
  | { type: 'late_within'; graceMs: number; lateAfterMs?: number }
  /** Run once now (no backlog). Default for interval jobs. */
  | { type: 'run_now' }
  /** Drop missed slots silently (recorded as missed). */
  | { type: 'skip' };

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
  /** 0..1 fraction of the delay randomly removed ("jitter"). */
  jitter: number;
}

export interface JobDefinition {
  id: string;
  schedule: JobSchedule;
  missed?: MissedPolicy;
  /** Max attempts per daily slot (retries within grace). Interval jobs always move on to the next slot. */
  maxAttempts?: number;
  backoff?: BackoffPolicy;
  /** Lease length; the handler's signal aborts when it expires. */
  leaseMs?: number;
  enabled?: boolean;
}

export interface JobRunContext {
  jobId: string;
  runId: string;
  slotKey: string;
  scheduledAt: string;
  late: boolean;
  lateByMs: number;
  attempt: number;
  /** Slot keys missed (e.g. during sleep) since the last successful run, folded into this run. */
  folded: string[];
  signal: AbortSignal;
  clock: Clock;
  /** Extends the lease by leaseMs. Returns false if the lease was lost. */
  heartbeat(): boolean;
}

export interface JobOutcome {
  detail?: Record<string, unknown>;
  /** Provider-limit-aware: minimum delay before the next run of an interval job. */
  nextDelayMs?: number;
}

export type JobHandler = (ctx: JobRunContext) => Promise<JobOutcome | void>;

/** Throw from a handler to control retry. */
export class JobError extends Error {
  readonly retryAfterMs: number | undefined;
  readonly permanent: boolean;
  constructor(message: string, opts: { retryAfterMs?: number; permanent?: boolean } = {}) {
    super(message);
    this.name = 'JobError';
    this.retryAfterMs = opts.retryAfterMs;
    this.permanent = opts.permanent === true;
  }
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 30_000, maxMs: 30 * 60_000, jitter: 0.2 };
export const DEFAULT_LEASE_MS = 5 * 60_000;

export interface RunReport {
  jobId: string;
  runId: string;
  slotKey: string;
  attempt: number;
  late: boolean;
  status: 'succeeded' | 'failed' | 'lease_lost';
  error?: string;
}

export interface TickReport {
  ran: RunReport[];
  folded: { jobId: string; slotKeys: string[] }[];
  skippedLeased: string[];
}

export interface SchedulerOptions {
  db: Db;
  clock: Clock;
  logger?: Logger;
  /** Identity of this process for leases. Default: random per instance. */
  instanceId?: string;
  /** Injected randomness in [0,1) for jitter (tests). */
  random?: () => number;
}

export interface JobStateView {
  id: string;
  enabled: boolean;
  nextRunAt: string;
  currentSlot: string | null;
  slotAttempts: number;
  consecutiveFailures: number;
  folded: string[];
  leaseOwner: string | null;
  leaseExpiresMs: number | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

export interface Scheduler {
  readonly instanceId: string;
  /** Persists (or updates) a job definition and binds its in-process handler. */
  register(def: JobDefinition, handler: JobHandler): void;
  /** Runs every due job once (awaits completion). */
  tick(): Promise<TickReport>;
  /** Runs one job now if it is due (or force=true: ignore next_run but still honour the lease). */
  runJob(jobId: string, opts?: { force?: boolean }): Promise<RunReport | null>;
  /**
   * Startup recovery. With assumeSoleOwner=true (the daemon holds the single-instance
   * lock) leases held by previous processes are dead and are released now; otherwise
   * they are left to expire.
   */
  recover(opts?: { assumeSoleOwner?: boolean }): number;
  setEnabled(jobId: string, enabled: boolean): void;
  state(jobId: string): JobStateView | null;
  list(): JobStateView[];
  runs(jobId: string, limit?: number): { id: string; slotKey: string; attempt: number; status: string; late: boolean; startedAt: string; finishedAt: string | null; error: string | null }[];
  /** Real-time loop for the daemon. */
  start(opts?: { pollMs?: number }): void;
  stop(): Promise<void>;
}

interface JobRow {
  id: string;
  def_json: string;
  def_hash: string;
  enabled: number;
  next_run_ms: number;
  next_run_at: string;
  current_slot: string | null;
  current_slot_ms: number | null;
  slot_attempts: number;
  consecutive_failures: number;
  folded_json: string;
  lease_owner: string | null;
  lease_run_id: string | null;
  lease_expires_ms: number | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_status: string | null;
  last_error: string | null;
}

function validateDefinition(def: JobDefinition): void {
  if (!/^[a-z0-9][a-z0-9_.:-]{0,95}$/.test(def.id)) throw new Error(`invalid job id "${def.id}"`);
  if (def.schedule.type === 'daily') {
    parseHhmm(def.schedule.time);
    assertTimezone(def.schedule.timezone);
  } else {
    if (!(def.schedule.everyMs >= 1000)) throw new Error('interval everyMs must be >= 1000');
  }
  if (def.maxAttempts !== undefined && !(def.maxAttempts >= 1)) throw new Error('maxAttempts must be >= 1');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function computeBackoffMs(failures: number, p: BackoffPolicy, random: () => number): number {
  const exp = Math.min(p.maxMs, p.baseMs * 2 ** Math.max(0, failures - 1));
  const jittered = exp * (1 - p.jitter * random());
  return Math.max(1000, Math.round(jittered));
}

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const { db, clock } = opts;
  const log = opts.logger ?? nullLogger;
  const instanceId = opts.instanceId ?? `sched-${randomUUID()}`;
  const random = opts.random ?? Math.random;
  const handlers = new Map<string, { def: JobDefinition; handler: JobHandler }>();
  const inProcess = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  const inFlight = new Set<Promise<unknown>>();
  let stopped = true;

  const getRow = (id: string) => db.prepare('SELECT * FROM sched_jobs WHERE id = ?').get(id) as JobRow | undefined;

  const firstRunMs = (def: JobDefinition, now: number): number => {
    if (def.schedule.type === 'daily') return nextDailyOccurrence(now, def.schedule.time, def.schedule.timezone);
    return now + (def.schedule.initialDelayMs ?? 0);
  };

  const missedOf = (def: JobDefinition): MissedPolicy =>
    def.missed ?? (def.schedule.type === 'daily' ? { type: 'late_within', graceMs: 2 * 3600_000 } : { type: 'run_now' });

  function register(def: JobDefinition, handler: JobHandler): void {
    validateDefinition(def);
    const now = clock.nowMs();
    const defJson = canonicalJson(def);
    const defHash = hashCanonical(def);
    withTransaction(db, () => {
      const row = getRow(def.id);
      if (!row) {
        const next = firstRunMs(def, now);
        db.prepare(
          `INSERT INTO sched_jobs (id, def_json, def_hash, enabled, next_run_ms, next_run_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(def.id, defJson, defHash, def.enabled === false ? 0 : 1, next, iso(next), iso(now), iso(now));
      } else if (row.def_hash !== defHash) {
        const oldDef = JSON.parse(row.def_json) as JobDefinition;
        const scheduleChanged = canonicalJson(oldDef.schedule) !== canonicalJson(def.schedule);
        const next = scheduleChanged ? firstRunMs(def, now) : row.next_run_ms;
        db.prepare(
          `UPDATE sched_jobs SET def_json = ?, def_hash = ?, next_run_ms = ?, next_run_at = ?,
             current_slot = CASE WHEN ? THEN NULL ELSE current_slot END,
             current_slot_ms = CASE WHEN ? THEN NULL ELSE current_slot_ms END,
             enabled = ?, updated_at = ? WHERE id = ?`,
        ).run(defJson, defHash, next, iso(next), scheduleChanged ? 1 : 0, scheduleChanged ? 1 : 0, def.enabled === false ? 0 : 1, iso(now), def.id);
      }
    });
    handlers.set(def.id, { def, handler });
  }

  function recover(o: { assumeSoleOwner?: boolean } = {}): number {
    const now = clock.nowMs();
    let n = 0;
    withTransaction(db, () => {
      const rows = db
        .prepare('SELECT id, lease_owner, lease_run_id, lease_expires_ms FROM sched_jobs WHERE lease_owner IS NOT NULL')
        .all() as { id: string; lease_owner: string; lease_run_id: string; lease_expires_ms: number }[];
      for (const r of rows) {
        if (r.lease_owner === instanceId) continue;
        if (!o.assumeSoleOwner && r.lease_expires_ms > now) continue;
        abandonLease(r.id, r.lease_run_id, now);
        n++;
      }
    });
    return n;
  }

  function abandonLease(jobId: string, runId: string | null, now: number): void {
    if (runId) {
      db.prepare(`UPDATE sched_runs SET status = 'abandoned', finished_at = ?, error = COALESCE(error, 'lease expired (process died or slept mid-run)') WHERE id = ? AND status = 'running'`).run(iso(now), runId);
    }
    db.prepare(
      `UPDATE sched_jobs SET lease_owner = NULL, lease_run_id = NULL, lease_expires_ms = NULL, last_status = 'abandoned', updated_at = ? WHERE id = ?`,
    ).run(iso(now), jobId);
  }

  interface Claim {
    runId: string;
    slotKey: string;
    slotMs: number;
    attempt: number;
    late: boolean;
    lateByMs: number;
    folded: string[];
  }

  type ClaimResult = { claim: Claim } | { folded: string[] } | { leased: true } | null;

  /** Synchronous claim: decides the slot, folds missed ones and takes the lease atomically. */
  function claim(def: JobDefinition, force: boolean): ClaimResult {
    const now = clock.nowMs();
    return withTransaction(db, (): ClaimResult => {
      let row = getRow(def.id);
      if (!row || !row.enabled) return null;
      if (row.lease_owner !== null) {
        if ((row.lease_expires_ms ?? 0) > now) return { leased: true };
        abandonLease(row.id, row.lease_run_id, now);
        row = getRow(def.id)!;
      }
      if (!force && row.next_run_ms > now) return null;

      const missed = missedOf(def);
      const maxAttempts = def.maxAttempts ?? (def.schedule.type === 'daily' ? 3 : 1);
      const folded: string[] = JSON.parse(row.folded_json) as string[];
      const newlyFolded: string[] = [];
      let slotKey: string;
      let slotMs: number;

      if (def.schedule.type === 'daily') {
        const { time, timezone } = def.schedule;
        const fold = (key: string, ms: number) => {
          db.prepare(
            `INSERT INTO sched_slots (job_id, slot_key, scheduled_at, status, attempts) VALUES (?, ?, ?, 'missed', 0)
             ON CONFLICT(job_id, slot_key) DO UPDATE SET status = CASE WHEN status = 'succeeded' THEN status ELSE 'missed' END`,
          ).run(def.id, key, iso(ms));
          if (!folded.includes(key)) folded.push(key);
          newlyFolded.push(key);
        };
        // Start from the retrying slot, else the scheduled one.
        let occ = row.current_slot_ms ?? row.next_run_ms;
        if (force && occ > now) occ = now;
        // Walk forward to the latest occurrence <= now; everything before is folded (no backlog).
        for (;;) {
          const nxt = nextDailyOccurrence(occ, time, timezone);
          if (nxt > now) break;
          if (occ <= now) fold(dailySlotKey(occ, timezone), occ);
          occ = nxt;
        }
        slotMs = occ;
        slotKey = force && occ === now ? `manual:${iso(now)}` : dailySlotKey(occ, timezone);
        const existing = db.prepare('SELECT status, attempts FROM sched_slots WHERE job_id = ? AND slot_key = ?').get(def.id, slotKey) as { status: string; attempts: number } | undefined;
        const advance = () => {
          const next = nextDailyOccurrence(Math.max(now, slotMs), time, timezone);
          db.prepare(
            `UPDATE sched_jobs SET next_run_ms = ?, next_run_at = ?, current_slot = NULL, current_slot_ms = NULL, slot_attempts = 0,
               folded_json = ?, updated_at = ? WHERE id = ?`,
          ).run(next, iso(next), JSON.stringify(folded), iso(now), def.id);
        };
        if (existing && (existing.status === 'succeeded' || existing.status === 'failed' || existing.status === 'missed')) {
          // Already finished (e.g. a restart replayed the tick): never run it again.
          advance();
          return { folded: newlyFolded };
        }
        const lateBy = now - slotMs;
        const grace = missed.type === 'late_within' ? missed.graceMs : missed.type === 'run_now' ? Number.POSITIVE_INFINITY : 0;
        const attemptsSoFar = existing?.attempts ?? 0;
        if (lateBy > grace || attemptsSoFar >= maxAttempts) {
          if (attemptsSoFar >= maxAttempts) {
            db.prepare(`UPDATE sched_slots SET status = 'failed', completed_at = ? WHERE job_id = ? AND slot_key = ?`).run(iso(now), def.id, slotKey);
          } else {
            fold(slotKey, slotMs);
          }
          advance();
          return { folded: newlyFolded };
        }
      } else {
        slotMs = row.next_run_ms;
        slotKey = iso(slotMs);
        if (force && slotMs > now) {
          slotMs = now;
          slotKey = `manual:${iso(now)}`;
        }
        const existing = db.prepare('SELECT status FROM sched_slots WHERE job_id = ? AND slot_key = ?').get(def.id, slotKey) as { status: string } | undefined;
        if (existing && existing.status !== 'running' && existing.status !== 'retrying') {
          const next = now + def.schedule.everyMs;
          db.prepare('UPDATE sched_jobs SET next_run_ms = ?, next_run_at = ?, updated_at = ? WHERE id = ?').run(next, iso(next), iso(now), def.id);
          return null;
        }
      }

      const lateAfter = missed.type === 'late_within' ? (missed.lateAfterMs ?? 5 * 60_000) : Number.POSITIVE_INFINITY;
      const lateByMs = Math.max(0, now - slotMs);
      const late = def.schedule.type === 'daily' && lateByMs > lateAfter;
      const prevAttempts = (db.prepare('SELECT attempts FROM sched_slots WHERE job_id = ? AND slot_key = ?').get(def.id, slotKey) as { attempts: number } | undefined)?.attempts ?? 0;
      const attempt = prevAttempts + 1;
      const runId = newId('run', clock);
      const leaseMs = def.leaseMs ?? DEFAULT_LEASE_MS;
      const leased = db
        .prepare(
          `UPDATE sched_jobs SET lease_owner = ?, lease_run_id = ?, lease_expires_ms = ?, current_slot = ?, current_slot_ms = ?,
             slot_attempts = ?, last_run_at = ?, updated_at = ?
           WHERE id = ? AND (lease_owner IS NULL OR lease_expires_ms <= ?)`,
        )
        .run(instanceId, runId, now + leaseMs, slotKey, slotMs, attempt, iso(now), iso(now), def.id, now);
      if (Number(leased.changes) !== 1) return { leased: true };
      db.prepare(
        `INSERT INTO sched_slots (job_id, slot_key, scheduled_at, status, attempts, late) VALUES (?, ?, ?, 'running', ?, ?)
         ON CONFLICT(job_id, slot_key) DO UPDATE SET status = 'running', attempts = excluded.attempts, late = excluded.late`,
      ).run(def.id, slotKey, iso(slotMs), attempt, late ? 1 : 0);
      db.prepare(
        `INSERT INTO sched_runs (id, job_id, slot_key, attempt, scheduled_at, started_at, status, late, lease_owner)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      ).run(runId, def.id, slotKey, attempt, iso(slotMs), iso(now), late ? 1 : 0, instanceId);
      return { claim: { runId, slotKey, slotMs, attempt, late, lateByMs, folded: [...folded] } };
    });
  }

  function finish(def: JobDefinition, c: Claim, result: { ok: true; outcome: JobOutcome | void } | { ok: false; error: unknown }): RunReport {
    const now = clock.nowMs();
    return withTransaction(db, (): RunReport => {
      const row = getRow(def.id);
      const base = { jobId: def.id, runId: c.runId, slotKey: c.slotKey, attempt: c.attempt, late: c.late };
      if (!row || row.lease_run_id !== c.runId || row.lease_owner !== instanceId) {
        db.prepare(`UPDATE sched_runs SET status = 'lease_lost', finished_at = ? WHERE id = ?`).run(iso(now), c.runId);
        log.warn('scheduler: lease lost before completion', { jobId: def.id, runId: c.runId });
        return { ...base, status: 'lease_lost' };
      }
      const outcome = result.ok ? result.outcome : undefined;
      const detail = outcome && outcome.detail ? canonicalJson(outcome.detail) : null;
      if (result.ok) {
        db.prepare(`UPDATE sched_runs SET status = 'succeeded', finished_at = ?, detail_json = ? WHERE id = ?`).run(iso(now), detail, c.runId);
        db.prepare(`UPDATE sched_slots SET status = 'succeeded', completed_at = ? WHERE job_id = ? AND slot_key = ?`).run(iso(now), def.id, c.slotKey);
        let next: number;
        if (def.schedule.type === 'daily') next = nextDailyOccurrence(Math.max(now, c.slotMs), def.schedule.time, def.schedule.timezone);
        else next = now + Math.max(def.schedule.everyMs, outcome?.nextDelayMs ?? 0);
        db.prepare(
          `UPDATE sched_jobs SET lease_owner = NULL, lease_run_id = NULL, lease_expires_ms = NULL, next_run_ms = ?, next_run_at = ?,
             current_slot = NULL, current_slot_ms = NULL, slot_attempts = 0, consecutive_failures = 0, folded_json = '[]',
             last_success_at = ?, last_status = 'succeeded', last_error = NULL, updated_at = ? WHERE id = ?`,
        ).run(next, iso(next), iso(now), iso(now), def.id);
        return { ...base, status: 'succeeded' };
      }
      const e = result.error;
      const message = e instanceof Error ? e.message : String(e);
      const failures = row.consecutive_failures + 1;
      const backoff = computeBackoffMs(failures, def.backoff ?? DEFAULT_BACKOFF, random);
      const retryAfter = e instanceof JobError ? (e.retryAfterMs ?? 0) : 0;
      const permanent = e instanceof JobError && e.permanent;
      db.prepare(`UPDATE sched_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`).run(iso(now), message.slice(0, 500), c.runId);
      let next: number;
      let keepSlot = false;
      if (def.schedule.type === 'daily') {
        const maxAttempts = def.maxAttempts ?? 3;
        const missed = missedOf(def);
        const grace = missed.type === 'late_within' ? missed.graceMs : Number.POSITIVE_INFINITY;
        const retryAt = now + Math.max(backoff, retryAfter);
        if (!permanent && c.attempt < maxAttempts && retryAt - c.slotMs <= grace) {
          next = retryAt;
          keepSlot = true;
          db.prepare(`UPDATE sched_slots SET status = 'retrying' WHERE job_id = ? AND slot_key = ?`).run(def.id, c.slotKey);
        } else {
          db.prepare(`UPDATE sched_slots SET status = 'failed', completed_at = ? WHERE job_id = ? AND slot_key = ?`).run(iso(now), def.id, c.slotKey);
          next = nextDailyOccurrence(Math.max(now, c.slotMs), def.schedule.time, def.schedule.timezone);
        }
      } else {
        db.prepare(`UPDATE sched_slots SET status = 'failed', completed_at = ? WHERE job_id = ? AND slot_key = ?`).run(iso(now), def.id, c.slotKey);
        next = now + Math.max(def.schedule.everyMs, backoff, retryAfter);
      }
      db.prepare(
        `UPDATE sched_jobs SET lease_owner = NULL, lease_run_id = NULL, lease_expires_ms = NULL, next_run_ms = ?, next_run_at = ?,
           current_slot = CASE WHEN ? THEN current_slot ELSE NULL END,
           current_slot_ms = CASE WHEN ? THEN current_slot_ms ELSE NULL END,
           slot_attempts = CASE WHEN ? THEN slot_attempts ELSE 0 END,
           consecutive_failures = ?, last_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
      ).run(next, iso(next), keepSlot ? 1 : 0, keepSlot ? 1 : 0, keepSlot ? 1 : 0, failures, message.slice(0, 500), iso(now), def.id);
      log.warn('scheduler: job failed', { jobId: def.id, attempt: c.attempt, error: message, nextRunAt: iso(next) });
      return { ...base, status: 'failed', error: message };
    });
  }

  async function execute(def: JobDefinition, handler: JobHandler, c: Claim): Promise<RunReport> {
    const leaseMs = def.leaseMs ?? DEFAULT_LEASE_MS;
    const ac = new AbortController();
    // Abort at lease expiry (real time); the lease row is authoritative either way.
    const t = setTimeout(() => ac.abort(new Error('lease expired')), leaseMs);
    t.unref?.();
    const ctx: JobRunContext = {
      jobId: def.id,
      runId: c.runId,
      slotKey: c.slotKey,
      scheduledAt: iso(c.slotMs),
      late: c.late,
      lateByMs: c.lateByMs,
      attempt: c.attempt,
      folded: c.folded,
      signal: ac.signal,
      clock,
      heartbeat: () => {
        const r = db
          .prepare('UPDATE sched_jobs SET lease_expires_ms = ? WHERE id = ? AND lease_run_id = ? AND lease_owner = ?')
          .run(clock.nowMs() + leaseMs, def.id, c.runId, instanceId);
        return Number(r.changes) === 1;
      },
    };
    try {
      const outcome = await handler(ctx);
      return finish(def, c, { ok: true, outcome });
    } catch (e) {
      return finish(def, c, { ok: false, error: e });
    } finally {
      clearTimeout(t);
    }
  }

  async function runOne(jobId: string, force: boolean, report?: TickReport): Promise<RunReport | null> {
    const h = handlers.get(jobId);
    if (!h || inProcess.has(jobId)) return null;
    const r = claim(h.def, force);
    if (!r) return null;
    if ('leased' in r) {
      report?.skippedLeased.push(jobId);
      return null;
    }
    if ('folded' in r) {
      if (r.folded.length) report?.folded.push({ jobId, slotKeys: r.folded });
      return null;
    }
    inProcess.add(jobId);
    try {
      const rr = await execute(h.def, h.handler, r.claim);
      report?.ran.push(rr);
      return rr;
    } finally {
      inProcess.delete(jobId);
    }
  }

  async function tick(): Promise<TickReport> {
    const report: TickReport = { ran: [], folded: [], skippedLeased: [] };
    const now = clock.nowMs();
    const due = db
      .prepare('SELECT id FROM sched_jobs WHERE enabled = 1 AND (next_run_ms <= ? OR (lease_owner IS NOT NULL AND lease_expires_ms <= ?)) ORDER BY next_run_ms, id')
      .all(now, now) as { id: string }[];
    await Promise.all(due.map((d) => runOne(d.id, false, report)));
    return report;
  }

  const view = (r: JobRow): JobStateView => ({
    id: r.id,
    enabled: r.enabled === 1,
    nextRunAt: r.next_run_at,
    currentSlot: r.current_slot,
    slotAttempts: r.slot_attempts,
    consecutiveFailures: r.consecutive_failures,
    folded: JSON.parse(r.folded_json) as string[],
    leaseOwner: r.lease_owner,
    leaseExpiresMs: r.lease_expires_ms,
    lastRunAt: r.last_run_at,
    lastSuccessAt: r.last_success_at,
    lastStatus: r.last_status,
    lastError: r.last_error,
  });

  return {
    instanceId,
    register,
    tick,
    runJob: (id, o) => runOne(id, o?.force === true),
    recover,
    setEnabled(jobId, enabled) {
      db.prepare('UPDATE sched_jobs SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, clock.nowIso(), jobId);
    },
    state(jobId) {
      const r = getRow(jobId);
      return r ? view(r) : null;
    },
    list() {
      return (db.prepare('SELECT * FROM sched_jobs ORDER BY id').all() as unknown as JobRow[]).map(view);
    },
    runs(jobId, limit = 50) {
      const rows = db
        .prepare('SELECT id, slot_key, attempt, status, late, started_at, finished_at, error FROM sched_runs WHERE job_id = ? ORDER BY started_at DESC, attempt DESC LIMIT ?')
        .all(jobId, limit) as { id: string; slot_key: string; attempt: number; status: string; late: number; started_at: string; finished_at: string | null; error: string | null }[];
      return rows.map((r) => ({ id: r.id, slotKey: r.slot_key, attempt: r.attempt, status: r.status, late: r.late === 1, startedAt: r.started_at, finishedAt: r.finished_at, error: r.error }));
    },
    start(o = {}) {
      if (!stopped) return;
      stopped = false;
      const poll = o.pollMs ?? 5000;
      // Each tick claims due jobs synchronously and lets long runs continue in the
      // background; the in-process set and the DB lease stop overlapping runs.
      const loop = () => {
        if (stopped) return;
        const p = tick().catch((e) => log.error('scheduler tick failed', { error: e }));
        inFlight.add(p);
        void p.finally(() => inFlight.delete(p));
        timer = setTimeout(loop, poll);
      };
      loop();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await Promise.all([...inFlight]);
    },
  };
}
