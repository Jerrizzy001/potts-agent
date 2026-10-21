import type { Clock } from '../core/clock.ts';
import { newId } from '../core/ids.ts';
import { nullLogger, type Logger } from '../core/log.ts';
import { withTransaction, type Db } from '../store/db.ts';
import { formatLocal, OWNER_TIMEZONE } from '../jobs/tz.ts';
import type { Outbox } from '../notifications/outbox.ts';
import type { UrgentEventStore } from '../notifications/urgent.ts';
import { activeMaintenance, type MonitoringConfig, type SiteConfig } from './config.ts';
import { createIncidentStore, type Incident, type IncidentClass, type IncidentStore } from './incidents.ts';
import {
  checkHealth,
  checkHomepage,
  checkJourney,
  createConnectivityChecker,
  TRANSPORT_CAUSES,
  type CheckResult,
  type ConnectivityChecker,
  type FailureCause,
  type FetchLike,
  type ReadinessProbe,
  type ReadinessResult,
} from './probe.ts';

export type ObservationClass = 'ok' | 'outage' | 'degraded' | 'monitor_auth' | 'rate_limited' | 'mac_offline' | 'maintenance';
type Verdict = 'fail' | 'ok' | 'unknown';

export interface Observation {
  siteId: string;
  at: string;
  cls: ObservationClass;
  cause: FailureCause | null;
  checks: CheckResult[];
  verdicts: Record<IncidentClass, Verdict>;
  retryAfterMs?: number;
  readiness?: Pick<ReadinessResult, 'status' | 'subsystems'>;
}

const CAUSE_PRIORITY: FailureCause[] = ['dns', 'tls', 'http_5xx', 'timeout', 'network', 'http_4xx', 'bad_health', 'http_unexpected', 'content_mismatch', 'slow', 'probe_error'];
function primaryCause(checks: CheckResult[]): FailureCause | null {
  const causes = checks.filter((c) => !c.ok && c.cause).map((c) => c.cause!);
  for (const p of CAUSE_PRIORITY) if (causes.includes(p)) return p;
  return causes[0] ?? null;
}

export interface ObserveDeps {
  fetch: FetchLike;
  clock: Clock;
  connectivity: ConnectivityChecker;
  readiness?: ReadinessProbe;
  signal?: AbortSignal;
}

/**
 * One observation of a site. Classification:
 *  - maintenance window active          → maintenance (nothing counted)
 *  - 429 from the site                   → rate_limited (back off; not an outage)
 *  - homepage fails with a transport error and BOTH independent connectivity
 *    endpoints fail                      → mac_offline (the Mac, not the site)
 *  - homepage fails                      → outage (cause: dns / tls / http_5xx / timeout / ...)
 *  - homepage OK, readiness 401/403      → monitor_auth (credential stale, not an outage)
 *  - homepage OK, health/readiness/journey failing → degraded
 *  - otherwise                           → ok
 */
export async function observeSite(site: SiteConfig, d: ObserveDeps): Promise<Observation> {
  const now = d.clock.nowMs();
  const at = new Date(now).toISOString();
  const base = { siteId: site.id, at };
  const unknown: Record<IncidentClass, Verdict> = { outage: 'unknown', degraded: 'unknown', monitor_auth: 'unknown' };
  if (activeMaintenance(site, now)) return { ...base, cls: 'maintenance', cause: null, checks: [], verdicts: unknown };

  const pd = { fetch: d.fetch, clock: d.clock, ...(d.signal ? { signal: d.signal } : {}) };
  const [home, health] = await Promise.all([checkHomepage(site, pd), checkHealth(site, pd)]);
  const checks: CheckResult[] = [home, health];
  const limited = checks.find((c) => c.cause === 'rate_limited');
  if (limited) {
    return { ...base, cls: 'rate_limited', cause: 'rate_limited', checks, verdicts: unknown, ...(limited.retryAfterMs !== undefined ? { retryAfterMs: limited.retryAfterMs } : {}) };
  }

  if (!home.ok) {
    const transportOnly = checks.filter((c) => !c.ok).every((c) => c.cause !== null && TRANSPORT_CAUSES.has(c.cause));
    if (transportOnly) {
      const conn = await d.connectivity.check(d.signal);
      checks.push(...conn.results);
      if (conn.state === 'offline') return { ...base, cls: 'mac_offline', cause: home.cause, checks, verdicts: unknown };
    }
    return { ...base, cls: 'outage', cause: primaryCause([home, health]), checks, verdicts: { outage: 'fail', degraded: 'unknown', monitor_auth: 'unknown' } };
  }

  // Homepage is up: outage verdict ok. Look deeper for degradation.
  const verdicts: Record<IncidentClass, Verdict> = { outage: 'ok', degraded: 'ok', monitor_auth: 'unknown' };
  const degradedChecks: CheckResult[] = [];
  if (!health.ok) degradedChecks.push(health);
  let readiness: ReadinessResult | undefined;
  let readinessUnknown = false;
  if (site.readiness && d.readiness) {
    readiness = await d.readiness.probe(site, d.signal);
    const rc: CheckResult = { check: 'readiness', ok: readiness.status === 'ok', statusCode: readiness.statusCode, latencyMs: readiness.latencyMs, cause: readiness.cause ?? null };
    checks.push(rc);
    switch (readiness.status) {
      case 'ok':
        verdicts.monitor_auth = 'ok';
        break;
      case 'auth_failed':
        verdicts.monitor_auth = 'fail';
        readinessUnknown = true;
        break;
      case 'rate_limited':
        readinessUnknown = true;
        break;
      default:
        verdicts.monitor_auth = readiness.statusCode !== null ? 'ok' : 'unknown';
        degradedChecks.push(rc);
    }
  }
  for (const j of site.journeys) {
    const jc = await checkJourney(site, j, pd);
    checks.push(jc);
    if (!jc.ok) degradedChecks.push(jc);
  }
  if (degradedChecks.length) verdicts.degraded = 'fail';
  else if (readinessUnknown) verdicts.degraded = 'unknown';

  let cls: ObservationClass = 'ok';
  let cause: FailureCause | null = null;
  if (verdicts.degraded === 'fail') {
    cls = 'degraded';
    cause = degradedChecks.find((c) => c.check === 'readiness')?.cause ?? primaryCause(degradedChecks);
  } else if (verdicts.monitor_auth === 'fail') {
    cls = 'monitor_auth';
    cause = 'auth';
  }
  const out: Observation = { ...base, cls, cause, checks, verdicts };
  if (readiness) out.readiness = { status: readiness.status, ...(readiness.subsystems ? { subsystems: readiness.subsystems } : {}) };
  if (readiness?.status === 'rate_limited' && readiness.retryAfterMs !== undefined) out.retryAfterMs = readiness.retryAfterMs;
  return out;
}

// ---------------------------------------------------------------------------

export interface SiteStatus {
  siteId: string;
  name: string;
  lastObservation: ObservationClass | 'unknown';
  lastCheckedAt: string | null;
  localOfflineSince: string | null;
  openIncidents: Incident[];
  resolvedSince: Incident[];
}

export interface MonitorRunReport {
  observations: Observation[];
  opened: Incident[];
  resolved: Incident[];
  /** Hint for the scheduler (provider-limit aware). */
  nextDelayMs: number;
}

export interface SiteMonitorOptions {
  db: Db;
  clock: Clock;
  config: MonitoringConfig;
  fetch: FetchLike;
  urgent?: UrgentEventStore;
  outbox?: Outbox;
  readiness?: ReadinessProbe;
  connectivity?: ConnectivityChecker;
  logger?: Logger;
  /** monitor_checks rows older than this are pruned. Default 14 days. */
  retentionMs?: number;
  /** Owner timezone for message text. Default America/Toronto. */
  timezone?: string;
}

export interface SiteMonitor {
  readonly incidents: IncidentStore;
  runOnce(signal?: AbortSignal): Promise<MonitorRunReport>;
  status(sinceIso: string): SiteStatus[];
  acknowledge(incidentId: string, by: string): Incident | null;
}

interface StreakRow {
  streak_start_ms: number | null;
  consecutive_failures: number;
  consecutive_successes: number;
  last_cause: string | null;
}

export function createSiteMonitor(o: SiteMonitorOptions): SiteMonitor {
  const { db, clock, config } = o;
  const log = o.logger ?? nullLogger;
  const incidents = createIncidentStore(db, clock, o.urgent);
  const connectivity = o.connectivity ?? createConnectivityChecker({ fetch: o.fetch, clock, endpoints: config.connectivityProbes });
  const retentionMs = o.retentionMs ?? 14 * 86400_000;
  const tz = o.timezone ?? OWNER_TIMEZONE;
  const local = (iso: string) => formatLocal(Date.parse(iso), tz);

  // Owner acknowledging the urgent event (e.g. "ack" on Telegram) acknowledges the incident too.
  o.urgent?.onChange((ev, change) => {
    if (change !== 'acknowledged') return;
    if (ev.sourceType !== 'website_outage' && ev.sourceType !== 'website_degraded' && ev.sourceType !== 'monitor_auth') return;
    incidents.acknowledge(ev.sourceRef, ev.acknowledgedBy ?? 'owner');
  });

  const getStreak = (siteId: string, cls: IncidentClass): StreakRow =>
    (db.prepare('SELECT streak_start_ms, consecutive_failures, consecutive_successes, last_cause FROM monitor_streaks WHERE site_id = ? AND incident_class = ?').get(siteId, cls) as
      | StreakRow
      | undefined) ?? { streak_start_ms: null, consecutive_failures: 0, consecutive_successes: 0, last_cause: null };
  const putStreak = (siteId: string, cls: IncidentClass, s: StreakRow) =>
    db
      .prepare(
        `INSERT INTO monitor_streaks (site_id, incident_class, streak_start_ms, consecutive_failures, consecutive_successes, last_cause, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(site_id, incident_class) DO UPDATE SET streak_start_ms = excluded.streak_start_ms, consecutive_failures = excluded.consecutive_failures,
           consecutive_successes = excluded.consecutive_successes, last_cause = excluded.last_cause, updated_at = excluded.updated_at`,
      )
      .run(siteId, cls, s.streak_start_ms, s.consecutive_failures, s.consecutive_successes, s.last_cause, clock.nowIso());

  function record(site: SiteConfig, ob: Observation, rep: MonitorRunReport): void {
    const nowMs = Date.parse(ob.at);
    withTransaction(db, () => {
      const ins = db.prepare(
        'INSERT INTO monitor_checks (id, site_id, at, at_ms, observation, check_name, ok, status_code, latency_ms, cause) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const c of ob.checks) ins.run(newId('chk', clock), site.id, ob.at, nowMs, ob.cls, c.check, c.ok ? 1 : 0, c.statusCode, c.latencyMs, c.cause);
      if (ob.checks.length === 0) ins.run(newId('chk', clock), site.id, ob.at, nowMs, ob.cls, ob.cls, 1, null, null, null);

      // Local availability: be explicit about monitoring gaps.
      const st = db.prepare('SELECT local_offline_since FROM monitor_site_state WHERE site_id = ?').get(site.id) as { local_offline_since: string | null } | undefined;
      let offlineSince = st?.local_offline_since ?? null;
      if (ob.cls === 'mac_offline') offlineSince ??= ob.at;
      else if (offlineSince) {
        o.outbox?.enqueue({
          dedupKey: `monitor-gap:${site.id}:${offlineSince}`,
          category: 'routine',
          text: `Monitoring gap for ${site.name}: this Mac had no internet from ${local(offlineSince)} to ${local(ob.at)}. The site was not checked during that time.`,
        });
        offlineSince = null;
      }
      const rlUntil = ob.cls === 'rate_limited' ? nowMs + Math.max(ob.retryAfterMs ?? 0, site.intervalSeconds * 1000) : null;
      db.prepare(
        `INSERT INTO monitor_site_state (site_id, last_observation, last_checked_at, local_offline_since, rate_limited_until_ms, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(site_id) DO UPDATE SET last_observation = excluded.last_observation, last_checked_at = excluded.last_checked_at,
           local_offline_since = excluded.local_offline_since, rate_limited_until_ms = excluded.rate_limited_until_ms, updated_at = excluded.updated_at`,
      ).run(site.id, ob.cls, ob.at, offlineSince, rlUntil, ob.at);

      for (const cls of ['outage', 'degraded', 'monitor_auth'] as const) {
        const v = ob.verdicts[cls];
        if (v === 'unknown') continue; // offline / maintenance / rate limited: freeze the streak
        const s = getStreak(site.id, cls);
        const open = incidents.unresolvedFor(site.id, cls);
        if (v === 'fail') {
          s.consecutive_failures += 1;
          s.consecutive_successes = 0;
          s.streak_start_ms ??= nowMs;
          s.last_cause = (cls === 'monitor_auth' ? 'auth' : ob.cause) ?? s.last_cause;
          if (open) {
            incidents.addEvidence(open.id, ob.checks.map((c) => ({ ...c, at: ob.at })));
          } else if (s.consecutive_failures >= site.minConsecutiveFailures && nowMs - s.streak_start_ms >= site.outageConfirmSeconds * 1000) {
            const r = incidents.open({ siteId: site.id, siteName: site.name, failureClass: cls, cause: s.last_cause, firstFailureMs: s.streak_start_ms });
            if (r.created) {
              // Copy the streak's evidence (timestamps/status codes/latencies only).
              const prior = db
                .prepare('SELECT at, check_name, ok, status_code, latency_ms, cause FROM monitor_checks WHERE site_id = ? AND at_ms >= ? ORDER BY at_ms, id')
                .all(site.id, s.streak_start_ms) as { at: string; check_name: string; ok: number; status_code: number | null; latency_ms: number | null; cause: FailureCause | null }[];
              incidents.addEvidence(
                r.incident.id,
                prior.map((p) => ({ at: p.at, check: p.check_name, ok: p.ok === 1, statusCode: p.status_code, latencyMs: p.latency_ms ?? 0, cause: p.cause })),
              );
              rep.opened.push(r.incident);
            }
          }
        } else {
          s.consecutive_successes += 1;
          s.consecutive_failures = 0;
          s.streak_start_ms = null;
          if (open) {
            incidents.addEvidence(open.id, ob.checks.map((c) => ({ ...c, at: ob.at })), 'recovery check');
            if (s.consecutive_successes >= site.recoveryConsecutiveSuccesses) {
              const resolved = incidents.resolve(open.id, `recovered: ${s.consecutive_successes} consecutive successful checks`);
              if (resolved) {
                rep.resolved.push(resolved);
                notifyRecovery(site, resolved);
              }
            }
          }
        }
        putStreak(site.id, cls, s);
      }
      db.prepare('DELETE FROM monitor_checks WHERE site_id = ? AND at_ms < ?').run(site.id, nowMs - retentionMs);
    });
  }

  function notifyRecovery(site: SiteConfig, inc: Incident): void {
    if (!o.outbox) return;
    const opening = inc.urgentEventId && o.urgent ? o.outbox.getByDedupKey(`urgent:incident:${inc.id}`) : null;
    const ownerWasTold = opening?.status === 'delivered';
    const mins = Math.round((Date.parse(inc.resolvedAt!) - Date.parse(inc.firstFailureAt)) / 60000);
    const what = inc.failureClass === 'outage' ? 'outage' : inc.failureClass === 'degraded' ? 'degradation' : 'monitor credential problem';
    o.outbox.enqueue({
      dedupKey: `incident-resolved:${inc.id}`,
      // If the owner was told about the incident, tell them it is over; otherwise it goes in the next briefing.
      category: ownerWasTold ? 'important' : 'routine',
      text: `Resolved: ${site.name} ${what} (${inc.cause ?? 'unknown cause'}) from ${local(inc.firstFailureAt)} to ${local(inc.resolvedAt!)} (~${mins} min). Ref ${inc.id}.`,
    });
  }

  return {
    incidents,
    async runOnce(signal) {
      const rep: MonitorRunReport = { observations: [], opened: [], resolved: [], nextDelayMs: 0 };
      if (!config.enabled) return rep;
      let nextDelay = Math.min(...config.sites.filter((s) => s.enabled).map((s) => s.intervalSeconds * 1000), 60_000);
      for (const site of config.sites) {
        if (!site.enabled) continue;
        const st = db.prepare('SELECT rate_limited_until_ms FROM monitor_site_state WHERE site_id = ?').get(site.id) as { rate_limited_until_ms: number | null } | undefined;
        if (st?.rate_limited_until_ms && st.rate_limited_until_ms > clock.nowMs()) {
          nextDelay = Math.max(nextDelay, st.rate_limited_until_ms - clock.nowMs());
          continue;
        }
        let ob: Observation;
        try {
          ob = await observeSite(site, { fetch: o.fetch, clock, connectivity, ...(o.readiness ? { readiness: o.readiness } : {}), ...(signal ? { signal } : {}) });
        } catch (e) {
          log.error('monitor: observation failed', { siteId: site.id, error: e });
          continue;
        }
        record(site, ob, rep);
        rep.observations.push(ob);
        if (ob.cls === 'rate_limited') nextDelay = Math.max(nextDelay, ob.retryAfterMs ?? site.intervalSeconds * 1000);
        log.info('monitor: observation', { siteId: site.id, cls: ob.cls, cause: ob.cause, checks: ob.checks.map((c) => `${c.check}:${c.statusCode ?? c.cause}`) });
      }
      rep.nextDelayMs = nextDelay;
      return rep;
    },
    status(sinceIso) {
      return config.sites.map((site) => {
        const st = db.prepare('SELECT last_observation, last_checked_at, local_offline_since FROM monitor_site_state WHERE site_id = ?').get(site.id) as
          | { last_observation: ObservationClass; last_checked_at: string; local_offline_since: string | null }
          | undefined;
        return {
          siteId: site.id,
          name: site.name,
          lastObservation: st?.last_observation ?? 'unknown',
          lastCheckedAt: st?.last_checked_at ?? null,
          localOfflineSince: st?.local_offline_since ?? null,
          openIncidents: incidents.listUnresolved(site.id),
          resolvedSince: incidents.resolvedSince(sinceIso, site.id),
        };
      });
    },
    acknowledge(id, by) {
      return incidents.acknowledge(id, by);
    },
  };
}
