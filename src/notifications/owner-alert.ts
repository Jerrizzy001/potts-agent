import type { Clock } from '../core/clock.ts';
import type { Db } from '../store/db.ts';
import type { ActionView, HookVerdict } from '../policy/decide.ts';
import type { LoadedPolicy } from '../policy/document.ts';
import { isQuietAt, quietEndAfter, type QuietHoursConfig } from './quiet-hours.ts';
import type { UrgentEventStore } from './urgent.ts';

/**
 * Owner alert call policy (`hooks.ownerAlert` for the broker; WP-7 places the
 * calls). Pure decision function plus a factory that binds it to live state.
 *
 * Payload contract for `call_owner_alert` actions:
 *   { "trigger": { "type": "urgent_event", "id": "<urgent event id>" }, ... }
 *
 * Rules, in order:
 *   1. The trigger must be named and must exist (trigger verification).
 *   2. Acknowledged or resolved triggers → deny (no stale calls, e.g. at 08:00).
 *   3. Triggers that are not call-worthy (shouldCall=false) → deny.
 *   4. Quiet hours (23:00–08:00 owner time) → hold. No urgent override.
 *   5. At most `maxAttemptsPerIncident` attempts (policy; default 3) → deny after.
 *   6. At least `retryIntervalSeconds` (policy; default 300) since the last attempt → hold before.
 * The broker evaluates this at proposal AND right before dispatch, so a retry
 * that would cross 23:00 is held at dispatch time.
 */
export interface TriggerState {
  status: 'open' | 'acknowledged' | 'resolved';
  shouldCall: boolean;
}

export interface AlertAttempts {
  count: number;
  lastAttemptMs: number | null;
}

export interface OwnerAlertInput {
  nowMs: number;
  quiet: QuietHoursConfig;
  triggerId: string | null;
  trigger: TriggerState | null;
  attempts: AlertAttempts;
  maxAttempts: number;
  retryIntervalSeconds: number;
}

export interface OwnerAlertDecision extends HookVerdict {
  /** When outcome is hold, the earliest instant a call could be allowed. */
  notBeforeMs?: number;
}

export function evaluateOwnerAlert(i: OwnerAlertInput): OwnerAlertDecision {
  if (!i.triggerId) return { outcome: 'deny', reasons: ['owner alert has no trigger reference (payload.trigger.id)'] };
  if (!i.trigger) return { outcome: 'deny', reasons: [`trigger ${i.triggerId} not found; alert cannot be verified`] };
  if (i.trigger.status === 'acknowledged') return { outcome: 'deny', reasons: [`trigger ${i.triggerId} already acknowledged by the owner`] };
  if (i.trigger.status === 'resolved') return { outcome: 'deny', reasons: [`trigger ${i.triggerId} is resolved; no stale call`] };
  if (!i.trigger.shouldCall) return { outcome: 'deny', reasons: [`trigger ${i.triggerId} does not qualify for a call`] };
  if (isQuietAt(i.nowMs, i.quiet)) {
    return {
      outcome: 'hold',
      reasons: [`quiet hours (${i.quiet.start}-${i.quiet.end} ${i.quiet.timezone}); no urgent override`],
      notBeforeMs: quietEndAfter(i.nowMs, i.quiet),
    };
  }
  if (i.attempts.count >= i.maxAttempts) return { outcome: 'deny', reasons: [`retry limit reached (${i.attempts.count}/${i.maxAttempts} attempts)`] };
  if (i.attempts.lastAttemptMs !== null) {
    const earliest = i.attempts.lastAttemptMs + i.retryIntervalSeconds * 1000;
    if (i.nowMs < earliest) return { outcome: 'hold', reasons: [`retry interval ${i.retryIntervalSeconds}s not yet elapsed`], notBeforeMs: earliest };
  }
  return { outcome: 'allow', reasons: [`verified trigger ${i.triggerId}; attempt ${i.attempts.count + 1}/${i.maxAttempts}`] };
}

export function triggerIdOf(action: Pick<ActionView, 'payload'>): string | null {
  const p = action.payload as { trigger?: { type?: unknown; id?: unknown } } | null;
  const t = p?.trigger;
  if (!t || t.type !== 'urgent_event' || typeof t.id !== 'string' || !t.id) return null;
  return t.id;
}

export interface AlertAttemptSource {
  attempts(triggerId: string): AlertAttempts;
}

/**
 * Counts prior owner-alert calls for a trigger from the broker's own tables
 * (actions + dispatches), so a restart can never reset the count. A dispatch
 * counts if it may have reached the provider (dispatching / succeeded /
 * uncertain / reconciled_sent). Read-only.
 */
export function createBrokerAlertAttemptSource(db: Db): AlertAttemptSource {
  const stmt = db.prepare(
    `SELECT COUNT(*) AS n, MAX(d.created_at) AS last
       FROM dispatches d JOIN actions a ON a.id = d.action_id
      WHERE a.kind = 'call_owner_alert'
        AND json_extract(a.payload_json, '$.trigger.id') = ?
        AND d.state IN ('dispatching','succeeded','uncertain','reconciled_sent')`,
  );
  return {
    attempts(triggerId) {
      const r = stmt.get(triggerId) as { n: number; last: string | null };
      return { count: Number(r.n), lastAttemptMs: r.last ? Date.parse(r.last) : null };
    },
  };
}

export interface OwnerAlertHookOptions {
  clock: Clock;
  quiet: QuietHoursConfig;
  urgent: Pick<UrgentEventStore, 'get'>;
  attempts: AlertAttemptSource;
}

/** Returns the function to register as broker `hooks.ownerAlert`. */
export function createOwnerAlertHook(o: OwnerAlertHookOptions): (action: ActionView, policy: LoadedPolicy) => HookVerdict {
  return (action, policy) => {
    const triggerId = triggerIdOf(action);
    const ev = triggerId ? o.urgent.get(triggerId) : null;
    const d = evaluateOwnerAlert({
      nowMs: o.clock.nowMs(),
      quiet: o.quiet,
      triggerId,
      trigger: ev ? { status: ev.status, shouldCall: ev.shouldCall } : null,
      attempts: triggerId ? o.attempts.attempts(triggerId) : { count: 0, lastAttemptMs: null },
      maxAttempts: policy.doc.ownerAlert.maxAttemptsPerIncident,
      retryIntervalSeconds: policy.doc.ownerAlert.retryIntervalSeconds,
    });
    return { outcome: d.outcome, reasons: d.reasons };
  };
}

/** WP-7 signal: should Potts call the owner about this event right now? */
export function shouldCallOwner(o: OwnerAlertHookOptions & { policy: LoadedPolicy }, eventId: string): OwnerAlertDecision {
  const ev = o.urgent.get(eventId);
  return evaluateOwnerAlert({
    nowMs: o.clock.nowMs(),
    quiet: o.quiet,
    triggerId: eventId,
    trigger: ev ? { status: ev.status, shouldCall: ev.shouldCall } : null,
    attempts: o.attempts.attempts(eventId),
    maxAttempts: o.policy.doc.ownerAlert.maxAttemptsPerIncident,
    retryIntervalSeconds: o.policy.doc.ownerAlert.retryIntervalSeconds,
  });
}
