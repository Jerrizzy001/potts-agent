import type { Clock } from '../core/clock.ts';
import { newId } from '../core/ids.ts';
import { withTransaction, type Db } from '../store/db.ts';
import type { UrgentEventStore } from '../notifications/urgent.ts';
import type { CheckResult } from './probe.ts';

export type IncidentClass = 'outage' | 'degraded' | 'monitor_auth';
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';

export interface Incident {
  id: string;
  siteId: string;
  failureClass: IncidentClass;
  cause: string | null;
  status: IncidentStatus;
  firstFailureAt: string;
  openedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  urgentEventId: string | null;
}

export interface EvidenceRow {
  at: string;
  check: string;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  cause: string | null;
  note: string | null;
}

interface Row {
  id: string;
  site_id: string;
  failure_class: IncidentClass;
  cause: string | null;
  status: IncidentStatus;
  first_failure_at: string;
  opened_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolution: string | null;
  urgent_event_id: string | null;
}

const toI = (r: Row): Incident => ({
  id: r.id,
  siteId: r.site_id,
  failureClass: r.failure_class,
  cause: r.cause,
  status: r.status,
  firstFailureAt: r.first_failure_at,
  openedAt: r.opened_at,
  acknowledgedAt: r.acknowledged_at,
  acknowledgedBy: r.acknowledged_by,
  resolvedAt: r.resolved_at,
  resolution: r.resolution,
  urgentEventId: r.urgent_event_id,
});

export interface OpenIncidentInput {
  siteId: string;
  siteName: string;
  failureClass: IncidentClass;
  cause: string | null;
  firstFailureMs: number;
}

export interface IncidentStore {
  /** Opens an incident unless one is already unresolved for site+class (dedup). */
  open(input: OpenIncidentInput): { incident: Incident; created: boolean };
  acknowledge(id: string, by: string): Incident | null;
  resolve(id: string, resolution: string): Incident | null;
  get(id: string): Incident | null;
  unresolvedFor(siteId: string, cls: IncidentClass): Incident | null;
  listUnresolved(siteId?: string): Incident[];
  resolvedSince(sinceIso: string, siteId?: string): Incident[];
  addEvidence(incidentId: string, checks: (CheckResult & { at?: string })[], note?: string): void;
  evidence(incidentId: string): EvidenceRow[];
}

const URGENT_TYPE = { outage: 'website_outage', degraded: 'website_degraded', monitor_auth: 'monitor_auth' } as const;

function incidentTitle(cls: IncidentClass, siteName: string, cause: string | null): string {
  switch (cls) {
    case 'outage':
      return `${siteName} looks down, confirmed for 10+ minutes (${cause ?? 'cause unknown'}); your own internet is fine`;
    case 'degraded':
      return `${siteName} is half-working: the homepage loads but the app checks are failing${cause ? ` (${cause})` : ''}`;
    case 'monitor_auth':
      return `${siteName}: my monitor login was rejected (401/403), so I cannot see the app health; the site itself may be fine`;
  }
}

/**
 * Incident store. Opening an incident raises a linked urgent event
 * (dedup "incident:<id>"); acknowledging or resolving the incident does the
 * same to the event, which stops queued messages and owner alert calls.
 * Evidence holds timestamps, check names, status codes and latencies only.
 */
export function createIncidentStore(db: Db, clock: Clock, urgent?: UrgentEventStore): IncidentStore {
  const get = (id: string) => {
    const r = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as Row | undefined;
    return r ? toI(r) : null;
  };
  const unresolvedFor = (siteId: string, cls: IncidentClass) => {
    const r = db.prepare(`SELECT * FROM incidents WHERE site_id = ? AND failure_class = ? AND status IN ('open','acknowledged')`).get(siteId, cls) as Row | undefined;
    return r ? toI(r) : null;
  };
  const addEvidence = (incidentId: string, checks: (CheckResult & { at?: string })[], note?: string) => {
    const stmt = db.prepare(
      'INSERT INTO incident_evidence (id, incident_id, at, check_name, ok, status_code, latency_ms, cause, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const c of checks) stmt.run(newId('evd', clock), incidentId, c.at ?? clock.nowIso(), c.check, c.ok ? 1 : 0, c.statusCode, c.latencyMs, c.cause, note ?? null);
  };
  return {
    open(input) {
      return withTransaction(db, () => {
        const existing = unresolvedFor(input.siteId, input.failureClass);
        if (existing) return { incident: existing, created: false };
        const id = newId('inc', clock);
        const now = clock.nowIso();
        db.prepare(
          `INSERT INTO incidents (id, site_id, failure_class, cause, status, first_failure_at, opened_at, updated_at)
           VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
        ).run(id, input.siteId, input.failureClass, input.cause, new Date(input.firstFailureMs).toISOString(), now, now);
        if (urgent) {
          const r = urgent.raise({
            dedupKey: `incident:${id}`,
            sourceType: URGENT_TYPE[input.failureClass],
            sourceRef: id,
            title: incidentTitle(input.failureClass, input.siteName, input.cause),
            detail: { incidentId: id, siteId: input.siteId, firstFailureAt: new Date(input.firstFailureMs).toISOString(), cause: input.cause },
            shouldCall: input.failureClass === 'outage',
          });
          db.prepare('UPDATE incidents SET urgent_event_id = ? WHERE id = ?').run(r.event.id, id);
        }
        return { incident: get(id)!, created: true };
      });
    },
    acknowledge(id, by) {
      return withTransaction(db, () => {
        const now = clock.nowIso();
        db.prepare(`UPDATE incidents SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE id = ? AND status = 'open'`).run(now, by, now, id);
        const inc = get(id);
        if (inc?.urgentEventId && urgent) urgent.acknowledge(inc.urgentEventId, by);
        return inc;
      });
    },
    resolve(id, resolution) {
      return withTransaction(db, () => {
        const now = clock.nowIso();
        db.prepare(`UPDATE incidents SET status = 'resolved', resolved_at = ?, resolution = ?, updated_at = ? WHERE id = ? AND status != 'resolved'`).run(now, resolution, now, id);
        const inc = get(id);
        if (inc?.urgentEventId && urgent) urgent.resolve(inc.urgentEventId, resolution);
        return inc;
      });
    },
    get,
    unresolvedFor,
    listUnresolved(siteId) {
      const rows = siteId
        ? db.prepare(`SELECT * FROM incidents WHERE status IN ('open','acknowledged') AND site_id = ? ORDER BY opened_at`).all(siteId)
        : db.prepare(`SELECT * FROM incidents WHERE status IN ('open','acknowledged') ORDER BY opened_at`).all();
      return (rows as unknown as Row[]).map(toI);
    },
    resolvedSince(sinceIso, siteId) {
      const rows = siteId
        ? db.prepare(`SELECT * FROM incidents WHERE status = 'resolved' AND resolved_at >= ? AND site_id = ? ORDER BY resolved_at`).all(sinceIso, siteId)
        : db.prepare(`SELECT * FROM incidents WHERE status = 'resolved' AND resolved_at >= ? ORDER BY resolved_at`).all(sinceIso);
      return (rows as unknown as Row[]).map(toI);
    },
    addEvidence,
    evidence(incidentId) {
      const rows = db
        .prepare('SELECT at, check_name, ok, status_code, latency_ms, cause, note FROM incident_evidence WHERE incident_id = ? ORDER BY at, id')
        .all(incidentId) as { at: string; check_name: string; ok: number; status_code: number | null; latency_ms: number | null; cause: string | null; note: string | null }[];
      return rows.map((r) => ({ at: r.at, check: r.check_name, ok: r.ok === 1, statusCode: r.status_code, latencyMs: r.latency_ms, cause: r.cause, note: r.note }));
    },
  };
}
