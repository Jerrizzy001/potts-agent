import type { Clock } from '../core/clock.ts';
import { canonicalJson } from '../core/hash.ts';
import { newId } from '../core/ids.ts';
import { withTransaction, type Db } from '../store/db.ts';

/**
 * Urgent events: the verified triggers behind owner notifications and owner
 * alert calls (outage confirmed >= 10 min, task due within 6h, interview
 * invitation, qualifying business enquiry). One row per dedup key, forever:
 * raising the same key again is a no-op, so a trigger fires once.
 *
 * Event text is built by trusted code from structured fields. Sender-supplied
 * text (e.g. "URGENT!!!" in a subject) never creates or escalates an event;
 * only the classifier category from the connector layer does.
 */
export type UrgentSourceType =
  | 'website_outage'
  | 'website_degraded'
  | 'monitor_auth'
  | 'task_due'
  | 'interview_invitation'
  | 'business_enquiry'
  | 'other';

export type UrgentStatus = 'open' | 'acknowledged' | 'resolved';

export interface UrgentEvent {
  id: string;
  dedupKey: string;
  sourceType: UrgentSourceType;
  sourceRef: string;
  title: string;
  detail: Record<string, unknown>;
  shouldCall: boolean;
  status: UrgentStatus;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolution: string | null;
}

export interface RaiseInput {
  dedupKey: string;
  sourceType: UrgentSourceType;
  sourceRef: string;
  title: string;
  detail?: Record<string, unknown>;
  shouldCall: boolean;
}

export type UrgentListener = (event: UrgentEvent, change: 'raised' | 'acknowledged' | 'resolved') => void;

export interface UrgentEventStore {
  /** Creates the event unless its dedup key already exists. */
  raise(input: RaiseInput): { event: UrgentEvent; created: boolean };
  acknowledge(id: string, by: string): UrgentEvent | null;
  resolve(id: string, resolution: string): UrgentEvent | null;
  get(id: string): UrgentEvent | null;
  getByDedupKey(key: string): UrgentEvent | null;
  listOpen(): UrgentEvent[];
  listBySource(sourceType: UrgentSourceType, status?: UrgentStatus): UrgentEvent[];
  resolvedSince(sinceIso: string): UrgentEvent[];
  /** Synchronous listeners run inside the same transaction as the change (used to enqueue notifications). */
  onChange(listener: UrgentListener): void;
}

interface Row {
  id: string;
  dedup_key: string;
  source_type: UrgentSourceType;
  source_ref: string;
  title: string;
  detail_json: string;
  should_call: number;
  status: UrgentStatus;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolution: string | null;
}

const toEvent = (r: Row): UrgentEvent => ({
  id: r.id,
  dedupKey: r.dedup_key,
  sourceType: r.source_type,
  sourceRef: r.source_ref,
  title: r.title,
  detail: JSON.parse(r.detail_json) as Record<string, unknown>,
  shouldCall: r.should_call === 1,
  status: r.status,
  createdAt: r.created_at,
  acknowledgedAt: r.acknowledged_at,
  acknowledgedBy: r.acknowledged_by,
  resolvedAt: r.resolved_at,
  resolution: r.resolution,
});

export function createUrgentEventStore(db: Db, clock: Clock): UrgentEventStore {
  const listeners: UrgentListener[] = [];
  const get = (id: string) => {
    const r = db.prepare('SELECT * FROM urgent_events WHERE id = ?').get(id) as Row | undefined;
    return r ? toEvent(r) : null;
  };
  const getByDedupKey = (k: string) => {
    const r = db.prepare('SELECT * FROM urgent_events WHERE dedup_key = ?').get(k) as Row | undefined;
    return r ? toEvent(r) : null;
  };
  const emit = (e: UrgentEvent, c: 'raised' | 'acknowledged' | 'resolved') => {
    for (const l of listeners) l(e, c);
  };
  return {
    raise(input) {
      return withTransaction(db, () => {
        const existing = getByDedupKey(input.dedupKey);
        if (existing) return { event: existing, created: false };
        const now = clock.nowIso();
        const id = newId('urg', clock);
        db.prepare(
          `INSERT INTO urgent_events (id, dedup_key, source_type, source_ref, title, detail_json, should_call, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        ).run(id, input.dedupKey, input.sourceType, input.sourceRef, input.title.slice(0, 300), canonicalJson(input.detail ?? {}), input.shouldCall ? 1 : 0, now, now);
        const ev = get(id)!;
        emit(ev, 'raised');
        return { event: ev, created: true };
      });
    },
    acknowledge(id, by) {
      return withTransaction(db, () => {
        const now = clock.nowIso();
        const r = db
          .prepare(`UPDATE urgent_events SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE id = ? AND status = 'open'`)
          .run(now, by, now, id);
        const ev = get(id);
        if (ev && Number(r.changes) === 1) emit(ev, 'acknowledged');
        return ev;
      });
    },
    resolve(id, resolution) {
      return withTransaction(db, () => {
        const now = clock.nowIso();
        const r = db
          .prepare(`UPDATE urgent_events SET status = 'resolved', resolved_at = ?, resolution = ?, updated_at = ? WHERE id = ? AND status != 'resolved'`)
          .run(now, resolution.slice(0, 300), now, id);
        const ev = get(id);
        if (ev && Number(r.changes) === 1) emit(ev, 'resolved');
        return ev;
      });
    },
    get,
    getByDedupKey,
    listOpen() {
      return (db.prepare(`SELECT * FROM urgent_events WHERE status = 'open' ORDER BY created_at`).all() as unknown as Row[]).map(toEvent);
    },
    listBySource(sourceType, status) {
      const rows = status
        ? db.prepare('SELECT * FROM urgent_events WHERE source_type = ? AND status = ? ORDER BY created_at').all(sourceType, status)
        : db.prepare('SELECT * FROM urgent_events WHERE source_type = ? ORDER BY created_at').all(sourceType);
      return (rows as unknown as Row[]).map(toEvent);
    },
    resolvedSince(sinceIso) {
      return (db.prepare(`SELECT * FROM urgent_events WHERE status = 'resolved' AND resolved_at >= ? ORDER BY resolved_at`).all(sinceIso) as unknown as Row[]).map(toEvent);
    },
    onChange(l) {
      listeners.push(l);
    },
  };
}
