import type { BriefingComposer, BriefingKind } from '../notifications/briefings.ts';
import type { DeadlineWatcher } from '../notifications/deadlines.ts';
import type { Outbox } from '../notifications/outbox.ts';
import type { SiteMonitor } from '../monitoring/monitor.ts';
import { localDateKey } from './tz.ts';
import { JobError, type JobDefinition, type JobHandler, type Scheduler } from './scheduler.ts';

/**
 * Sync interface for mail/calendar readers (WP-4 implements it).
 * The scheduler calls `sync` every 5 minutes by default; the result controls
 * the next interval (rate limits and auth expiry back off instead of hammering).
 */
export interface SyncSource {
  /** Unique, e.g. "gmail-personal.mail" or "outlook-work.calendar". */
  id: string;
  kind: 'mail' | 'calendar' | 'other';
  /** Human label for owner messages, e.g. "Gmail (personal)". */
  label: string;
  sync(ctx: { signal: AbortSignal; attempt: number }): Promise<SyncResult>;
}

export type SyncResult =
  | { status: 'ok'; newItems: number }
  /** Provider said slow down; next run waits at least retryAfterMs. */
  | { status: 'rate_limited'; retryAfterMs: number }
  /** Session/token expired: status becomes stale and a sign-in request is queued. */
  | { status: 'auth_expired' }
  | { status: 'error'; message: string; retryable: boolean };

export const SYNC_INTERVAL_MS = 5 * 60_000;
export const MONITOR_INTERVAL_MS = 60_000;
export const DISPATCH_INTERVAL_MS = 30_000;
export const AUTH_EXPIRED_RECHECK_MS = 30 * 60_000;

export interface Job {
  definition: JobDefinition;
  handler: JobHandler;
}

export function createSyncJob(
  source: SyncSource,
  o: { everyMs?: number; outbox?: Outbox; timezone?: string; onStatus?: (sourceId: string, r: SyncResult) => void } = {},
): Job {
  const everyMs = o.everyMs ?? SYNC_INTERVAL_MS;
  return {
    definition: {
      id: `sync:${source.id}`,
      schedule: { type: 'interval', everyMs },
      missed: { type: 'run_now' },
      backoff: { baseMs: 60_000, maxMs: 60 * 60_000, jitter: 0.25 },
      leaseMs: 4 * 60_000,
    },
    handler: async (ctx) => {
      const r = await source.sync({ signal: ctx.signal, attempt: ctx.attempt });
      o.onStatus?.(source.id, r);
      switch (r.status) {
        case 'ok':
          return { detail: { newItems: r.newItems } };
        case 'rate_limited':
          return { detail: { rateLimited: true }, nextDelayMs: Math.min(Math.max(r.retryAfterMs, everyMs), 6 * 3600_000) };
        case 'auth_expired':
          o.outbox?.enqueue({
            dedupKey: `signin:${source.id}:${localDateKey(ctx.clock.nowMs(), o.timezone ?? 'America/Toronto')}`,
            category: 'routine',
            text: `${source.label}: sign-in expired. Status is stale until you sign in again (Potts will not retry the login itself).`,
          });
          return { detail: { authExpired: true }, nextDelayMs: AUTH_EXPIRED_RECHECK_MS };
        case 'error':
          throw new JobError(r.message, { permanent: !r.retryable });
      }
    },
  };
}

export function briefingKindFor(id: string, time: string): BriefingKind {
  if (id === 'morning' || id === 'evening' || id === 'night') return id;
  const h = Number(time.slice(0, 2));
  return h < 12 ? 'morning' : h < 20 ? 'evening' : 'night';
}

export function createBriefingJob(o: { briefingId: string; kind: BriefingKind; time: string; timezone: string; composer: BriefingComposer; graceMs?: number }): Job {
  return {
    definition: {
      id: `briefing:${o.briefingId}`,
      schedule: { type: 'daily', time: o.time, timezone: o.timezone },
      missed: { type: 'late_within', graceMs: o.graceMs ?? 2 * 3600_000, lateAfterMs: 5 * 60_000 },
      maxAttempts: 3,
      backoff: { baseMs: 60_000, maxMs: 15 * 60_000, jitter: 0.2 },
      leaseMs: 5 * 60_000,
    },
    handler: async (ctx) => {
      const r = await o.composer.deliver(o.briefingId, o.kind, ctx.slotKey, { late: ctx.late, scheduledAt: ctx.scheduledAt, folded: ctx.folded, signal: ctx.signal });
      return { detail: { duplicate: r.duplicate, items: r.draft?.itemCount ?? 0, summarized: r.draft?.summarized ?? false } };
    },
  };
}

export function createMonitorJob(monitor: SiteMonitor, everyMs = MONITOR_INTERVAL_MS): Job {
  return {
    definition: { id: 'monitor:websites', schedule: { type: 'interval', everyMs }, missed: { type: 'run_now' }, leaseMs: 2 * 60_000, backoff: { baseMs: 60_000, maxMs: 10 * 60_000, jitter: 0.2 } },
    handler: async (ctx) => {
      const r = await monitor.runOnce(ctx.signal);
      return { detail: { observations: r.observations.map((x) => `${x.siteId}:${x.cls}`), opened: r.opened.length, resolved: r.resolved.length }, nextDelayMs: r.nextDelayMs };
    },
  };
}

export function createDispatchJob(outbox: Outbox, everyMs = DISPATCH_INTERVAL_MS): Job {
  return {
    definition: { id: 'notifications:dispatch', schedule: { type: 'interval', everyMs }, missed: { type: 'run_now' }, leaseMs: 3 * 60_000 },
    handler: async () => {
      const r = await outbox.dispatchDue();
      return { detail: { delivered: r.delivered.length, held: r.held.length, dropped: r.dropped.length, uncertain: r.uncertain.length } };
    },
  };
}

export function createDeadlineJob(watcher: DeadlineWatcher, everyMs = SYNC_INTERVAL_MS): Job {
  return {
    definition: { id: 'deadlines:watch', schedule: { type: 'interval', everyMs }, missed: { type: 'run_now' }, leaseMs: 3 * 60_000 },
    handler: async (ctx) => {
      const r = await watcher.run(ctx.signal);
      if (r.errors.length && r.raised.length === 0 && r.resolved.length === 0) throw new JobError(r.errors.join('; '));
      return { detail: { raised: r.raised.length, resolved: r.resolved.length, errors: r.errors.length } };
    },
  };
}

export interface StandardJobDeps {
  timezone: string;
  briefings: { id: string; time: string; enabled?: boolean }[];
  composer?: BriefingComposer;
  /** Config notifications.briefingGraceMinutes (default 120): late briefings within this are sent once, marked late. */
  briefingGraceMs?: number;
  outbox?: Outbox;
  monitor?: SiteMonitor;
  deadlines?: DeadlineWatcher;
  syncSources?: SyncSource[];
  onSyncStatus?: (sourceId: string, r: SyncResult) => void;
}

/** Registers every WP-5 job with the single scheduler. Returns the job ids. */
export function registerStandardJobs(s: Scheduler, d: StandardJobDeps): string[] {
  const jobs: Job[] = [];
  if (d.composer) {
    for (const b of d.briefings) {
      const j = createBriefingJob({
        briefingId: b.id,
        kind: briefingKindFor(b.id, b.time),
        time: b.time,
        timezone: d.timezone,
        composer: d.composer,
        ...(d.briefingGraceMs !== undefined ? { graceMs: d.briefingGraceMs } : {}),
      });
      if (b.enabled === false) j.definition.enabled = false;
      jobs.push(j);
    }
  }
  if (d.monitor) jobs.push(createMonitorJob(d.monitor));
  if (d.outbox) jobs.push(createDispatchJob(d.outbox));
  if (d.deadlines) jobs.push(createDeadlineJob(d.deadlines));
  for (const src of d.syncSources ?? []) {
    jobs.push(createSyncJob(src, { ...(d.outbox ? { outbox: d.outbox } : {}), timezone: d.timezone, ...(d.onSyncStatus ? { onStatus: d.onSyncStatus } : {}) }));
  }
  for (const j of jobs) s.register(j.definition, j.handler);
  return jobs.map((j) => j.definition.id);
}
