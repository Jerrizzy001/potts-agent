/** Persistence for owner-alert incidents, call attempts, webhook dedupe and usage. */
import type { Db } from '../store/db.ts';
import { withTransaction } from '../store/db.ts';
import type { Clock } from '../core/clock.ts';
import { newId } from '../core/ids.ts';
import { canonicalJson } from '../core/hash.ts';
import type { AlertTrigger } from './types.ts';

export type IncidentStatus = 'active' | 'acknowledged' | 'resolved' | 'exhausted' | 'cancelled';

export interface AlertIncident {
  id: string;
  trigger: AlertTrigger;
  label: string | null;
  status: IncidentStatus;
  nextAttemptAt: string;
  pendingActionId: string | null;
  statusReason: string | null;
  acknowledgedAt: string | null;
  acknowledgedCall: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AlertCall {
  id: string;
  incidentId: string;
  attempt: number;
  actionId: string;
  dispatchId: string | null;
  provider: string;
  providerCallId: string | null;
  status: string;
  answeredBy: string | null;
  acknowledged: boolean;
  durationSeconds: number | null;
  price: string | null;
  priceUnit: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

type IRow = { id: string; trigger_kind: string; label: string | null; status: string; next_attempt_at: string; pending_action_id: string | null; status_reason: string | null; acknowledged_at: string | null; acknowledged_call: string | null; created_at: string; updated_at: string };
type CRow = { id: string; incident_id: string; attempt: number; action_id: string; dispatch_id: string | null; provider: string; provider_call_id: string | null; status: string; answered_by: string | null; acknowledged: number; duration_seconds: number | null; price: string | null; price_unit: string | null; error: string | null; created_at: string; updated_at: string };

const toI = (r: IRow): AlertIncident => ({
  id: r.id, trigger: r.trigger_kind as AlertTrigger, label: r.label, status: r.status as IncidentStatus, nextAttemptAt: r.next_attempt_at, pendingActionId: r.pending_action_id,
  statusReason: r.status_reason, acknowledgedAt: r.acknowledged_at, acknowledgedCall: r.acknowledged_call, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toC = (r: CRow): AlertCall => ({
  id: r.id, incidentId: r.incident_id, attempt: r.attempt, actionId: r.action_id, dispatchId: r.dispatch_id, provider: r.provider, providerCallId: r.provider_call_id,
  status: r.status, answeredBy: r.answered_by, acknowledged: r.acknowledged === 1, durationSeconds: r.duration_seconds, price: r.price, priceUnit: r.price_unit,
  error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
});

export interface UsageSummary {
  since: string;
  calls: number;
  answered: number;
  acknowledged: number;
  totalDurationSeconds: number;
  /** Provider-reported cost by currency (Twilio reports negative amounts; shown as positive spend). */
  spendByUnit: Record<string, number>;
  unpriced: number;
}

export type BeginAttempt =
  | { ok: true; call: AlertCall; reused: boolean }
  | { ok: false; reason: string };

export interface TelephonyStore {
  raise(i: { id: string; trigger: AlertTrigger; label?: string | null }): { incident: AlertIncident; created: boolean };
  incident(id: string): AlertIncident | undefined;
  dueIncidents(nowIso: string): AlertIncident[];
  setIncident(id: string, f: Partial<Pick<AlertIncident, 'status' | 'nextAttemptAt' | 'pendingActionId' | 'statusReason'>>): void;
  acknowledge(incidentId: string, callId: string): boolean;
  calls(incidentId: string): AlertCall[];
  call(id: string): AlertCall | undefined;
  callByAction(actionId: string): AlertCall | undefined;
  callBySid(sid: string): AlertCall | undefined;
  /** Atomically records an attempt BEFORE the provider is called (or reuses the row of the same action). */
  beginAttempt(a: { incidentId: string; attempt: number; actionId: string; dispatchId: string; provider: string; maxAttempts: number }): BeginAttempt;
  updateCall(id: string, f: Partial<Pick<AlertCall, 'providerCallId' | 'status' | 'answeredBy' | 'durationSeconds' | 'price' | 'priceUnit' | 'error'>> & { acknowledged?: boolean }): void;
  /** True the first time a dedupe key is seen. */
  firstSeen(key: string, path: string, callSid: string | null): boolean;
  logEvent(e: { callId: string | null; callSid: string | null; path: string; outcome: string; fields: Record<string, string> }): void;
  usage(sinceIso: string): UsageSummary;
  /** Placed calls (provider id known) still lacking a provider price. */
  unpricedCalls(sinceIso: string): AlertCall[];
}

export function createTelephonyStore(db: Db, clock: Clock): TelephonyStore {
  const getI = (id: string) => db.prepare('SELECT * FROM owner_alert_incidents WHERE id = ?').get(id) as IRow | undefined;
  const store: TelephonyStore = {
    raise(i) {
      return withTransaction(db, () => {
        const prior = getI(i.id);
        if (prior) return { incident: toI(prior), created: false };
        const now = clock.nowIso();
        db.prepare('INSERT INTO owner_alert_incidents (id, trigger_kind, label, status, next_attempt_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(i.id, i.trigger, i.label ?? null, 'active', now, now, now);
        return { incident: toI(getI(i.id)!), created: true };
      });
    },
    incident: (id) => {
      const r = getI(id);
      return r ? toI(r) : undefined;
    },
    dueIncidents: (nowIso) => (db.prepare("SELECT * FROM owner_alert_incidents WHERE status = 'active' AND next_attempt_at <= ? ORDER BY next_attempt_at, id").all(nowIso) as IRow[]).map(toI),
    setIncident(id, f) {
      const cur = getI(id);
      if (!cur) return;
      db.prepare('UPDATE owner_alert_incidents SET status = ?, next_attempt_at = ?, pending_action_id = ?, status_reason = ?, updated_at = ? WHERE id = ?').run(
        f.status ?? cur.status, f.nextAttemptAt ?? cur.next_attempt_at, f.pendingActionId !== undefined ? f.pendingActionId : cur.pending_action_id,
        f.statusReason !== undefined ? f.statusReason : cur.status_reason, clock.nowIso(), id,
      );
    },
    acknowledge(incidentId, callId) {
      return withTransaction(db, () => {
        const now = clock.nowIso();
        db.prepare('UPDATE owner_alert_calls SET acknowledged = 1, updated_at = ? WHERE id = ?').run(now, callId);
        const r = db.prepare("UPDATE owner_alert_incidents SET status = 'acknowledged', acknowledged_at = ?, acknowledged_call = ?, pending_action_id = NULL, status_reason = 'owner pressed 1', updated_at = ? WHERE id = ? AND status = 'active'").run(now, callId, now, incidentId);
        return Number(r.changes) > 0;
      });
    },
    calls: (incidentId) => (db.prepare('SELECT * FROM owner_alert_calls WHERE incident_id = ? ORDER BY attempt').all(incidentId) as CRow[]).map(toC),
    call: (id) => {
      const r = db.prepare('SELECT * FROM owner_alert_calls WHERE id = ?').get(id) as CRow | undefined;
      return r ? toC(r) : undefined;
    },
    callByAction: (actionId) => {
      const r = db.prepare('SELECT * FROM owner_alert_calls WHERE action_id = ?').get(actionId) as CRow | undefined;
      return r ? toC(r) : undefined;
    },
    callBySid: (sid) => {
      const r = db.prepare('SELECT * FROM owner_alert_calls WHERE provider_call_id = ?').get(sid) as CRow | undefined;
      return r ? toC(r) : undefined;
    },
    beginAttempt(a) {
      return withTransaction(db, (): BeginAttempt => {
        const mine = db.prepare('SELECT * FROM owner_alert_calls WHERE action_id = ?').get(a.actionId) as CRow | undefined;
        if (mine) {
          if (mine.incident_id !== a.incidentId || mine.attempt !== a.attempt) return { ok: false, reason: 'action already bound to a different attempt' };
          db.prepare("UPDATE owner_alert_calls SET dispatch_id = ?, status = 'placing', error = NULL, updated_at = ? WHERE id = ?").run(a.dispatchId, clock.nowIso(), mine.id);
          return { ok: true, call: toC(db.prepare('SELECT * FROM owner_alert_calls WHERE id = ?').get(mine.id) as CRow), reused: true };
        }
        const taken = db.prepare('SELECT action_id FROM owner_alert_calls WHERE incident_id = ? AND attempt = ?').get(a.incidentId, a.attempt) as { action_id: string } | undefined;
        if (taken) return { ok: false, reason: `attempt ${a.attempt} already used by ${taken.action_id}` };
        const count = (db.prepare('SELECT COUNT(*) AS n FROM owner_alert_calls WHERE incident_id = ?').get(a.incidentId) as { n: number }).n;
        if (count >= a.maxAttempts) return { ok: false, reason: `attempt limit ${a.maxAttempts} reached` };
        if (a.attempt !== count + 1) return { ok: false, reason: `attempt ${a.attempt} out of sequence (expected ${count + 1})` };
        const id = newId('call', clock);
        const now = clock.nowIso();
        db.prepare("INSERT INTO owner_alert_calls (id, incident_id, attempt, action_id, dispatch_id, provider, status, created_at, updated_at) VALUES (?,?,?,?,?,?,'placing',?,?)").run(
          id, a.incidentId, a.attempt, a.actionId, a.dispatchId, a.provider, now, now,
        );
        return { ok: true, call: toC(db.prepare('SELECT * FROM owner_alert_calls WHERE id = ?').get(id) as CRow), reused: false };
      });
    },
    updateCall(id, f) {
      const sets: string[] = [];
      const vals: (string | number | null)[] = [];
      const map: Record<string, string> = { providerCallId: 'provider_call_id', status: 'status', answeredBy: 'answered_by', durationSeconds: 'duration_seconds', price: 'price', priceUnit: 'price_unit', error: 'error' };
      for (const [k, col] of Object.entries(map)) {
        const v = (f as Record<string, unknown>)[k];
        if (v !== undefined) {
          sets.push(`${col} = ?`);
          vals.push(v as string | number | null);
        }
      }
      if (f.acknowledged !== undefined) {
        sets.push('acknowledged = ?');
        vals.push(f.acknowledged ? 1 : 0);
      }
      if (!sets.length) return;
      sets.push('updated_at = ?');
      vals.push(clock.nowIso(), id);
      db.prepare(`UPDATE owner_alert_calls SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    },
    firstSeen(key, path, callSid) {
      const r = db.prepare('INSERT OR IGNORE INTO telephony_webhook_seen (dedupe_key, path, call_sid, received_at) VALUES (?,?,?,?)').run(key, path, callSid, clock.nowIso());
      return Number(r.changes) > 0;
    },
    logEvent(e) {
      db.prepare('INSERT INTO telephony_webhook_events (id, call_id, call_sid, path, outcome, fields_json, received_at) VALUES (?,?,?,?,?,?,?)').run(
        newId('twe', clock), e.callId, e.callSid, e.path, e.outcome, canonicalJson(e.fields), clock.nowIso(),
      );
    },
    unpricedCalls: (since) =>
      (db.prepare('SELECT * FROM owner_alert_calls WHERE created_at >= ? AND provider_call_id IS NOT NULL AND price IS NULL ORDER BY created_at').all(since) as CRow[]).map(toC),
    usage(since) {
      const rows = (db.prepare('SELECT * FROM owner_alert_calls WHERE created_at >= ?').all(since) as CRow[]).map(toC);
      const spend: Record<string, number> = {};
      let unpriced = 0;
      for (const r of rows) {
        if (r.price === null || r.priceUnit === null) {
          if (r.providerCallId) unpriced++;
          continue;
        }
        const n = Math.abs(Number(r.price));
        if (Number.isFinite(n)) spend[r.priceUnit] = Math.round(((spend[r.priceUnit] ?? 0) + n) * 1e6) / 1e6;
      }
      return {
        since,
        calls: rows.filter((r) => r.providerCallId).length,
        answered: rows.filter((r) => r.answeredBy || (r.durationSeconds ?? 0) > 0).length,
        acknowledged: rows.filter((r) => r.acknowledged).length,
        totalDurationSeconds: rows.reduce((n, r) => n + (r.durationSeconds ?? 0), 0),
        spendByUnit: spend,
        unpriced,
      };
    },
  };
  return store;
}
