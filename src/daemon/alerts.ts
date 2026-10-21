/**
 * WP-5 ↔ WP-7 binding for owner alert calls.
 *
 * - OwnerAlertDecider: WP-5 quiet hours (23:00–08:00 owner time, no urgent
 *   override), evaluated at proposal, at broker dispatch and in the executor.
 * - IncidentValidator: an alert incident id IS the urgent event id; it stays
 *   active only while the urgent event is open and call-worthy, so a resolved
 *   or acknowledged event never produces a stale (e.g. 08:00) call.
 * - Binding: a newly raised call-worthy urgent event registers an alert
 *   incident; acknowledgement/resolution resolves it; a DTMF acknowledgement
 *   on the call acknowledges the urgent event (which drops held messages).
 */
import { isQuietAt, quietEndAfter, type QuietHoursConfig } from '../notifications/quiet-hours.ts';
import type { UrgentEvent, UrgentEventStore, UrgentSourceType } from '../notifications/urgent.ts';
import type { AlertTrigger, IncidentValidator, OwnerAlertDecider } from '../telephony/types.ts';
import type { OwnerAlertService } from '../telephony/owner-alert.ts';

export function createQuietHoursDecider(quiet: QuietHoursConfig, opts: { callsAllowed?: boolean } = {}): OwnerAlertDecider {
  return {
    evaluateCall(at) {
      if (opts.callsAllowed === false) return { allowed: false, reason: 'owner alert calls are switched off' };
      const ms = at.getTime();
      if (!isQuietAt(ms, quiet)) return { allowed: true, reason: 'outside quiet hours' };
      return { allowed: false, reason: `quiet hours (${quiet.start}-${quiet.end} ${quiet.timezone}); no urgent override`, nextAllowedAt: new Date(quietEndAfter(ms, quiet)).toISOString() };
    },
  };
}

export function createUrgentIncidentValidator(urgent: Pick<UrgentEventStore, 'get'>): IncidentValidator {
  return {
    revalidate(incidentId) {
      const ev = urgent.get(incidentId);
      if (!ev) return { active: false, reason: 'urgent event not found' };
      if (ev.status === 'acknowledged') return { active: false, reason: 'acknowledged by the owner' };
      if (ev.status === 'resolved') return { active: false, reason: `resolved (${ev.resolution ?? 'resolved'})` };
      if (!ev.shouldCall) return { active: false, reason: 'event does not qualify for a call' };
      return { active: true, reason: 'urgent event still open' };
    },
  };
}

const TRIGGER: Partial<Record<UrgentSourceType, AlertTrigger>> = {
  website_outage: 'website_outage',
  task_due: 'task_due',
  interview_invitation: 'interview_invitation',
  business_enquiry: 'business_opportunity',
};

export function triggerForEvent(ev: Pick<UrgentEvent, 'sourceType' | 'shouldCall'>): AlertTrigger | null {
  return ev.shouldCall ? (TRIGGER[ev.sourceType] ?? null) : null;
}

/** Spoken label: generic words only (no names, subjects or addresses go to the speech provider). */
const LABEL: Record<AlertTrigger, string> = {
  website_outage: 'website outage',
  task_due: 'task due soon',
  interview_invitation: 'interview invitation',
  business_opportunity: 'business enquiry',
  test: 'test',
};

export function bindUrgentEventsToAlertCalls(urgent: UrgentEventStore, service: OwnerAlertService): void {
  urgent.onChange((ev, change) => {
    if (change === 'raised') {
      const trigger = triggerForEvent(ev);
      if (trigger) service.raise({ incidentId: ev.id, trigger, label: LABEL[trigger] });
      return;
    }
    service.resolve(ev.id, change === 'acknowledged' ? 'owner acknowledged' : `event resolved (${ev.resolution ?? 'resolved'})`);
  });
}

/** Prefix of owner-requested test-call incident ids (`/potts testcall`). */
export const TEST_CALL_PREFIX = 'test:';
/** A test call that has not rung within this window is dropped (e.g. queued just before quiet hours). */
export const TEST_CALL_TTL_MS = 10 * 60_000;

/**
 * Incident validator that also understands owner test calls: a `test:` incident
 * is valid only while it is active, has trigger `test`, is younger than
 * TEST_CALL_TTL_MS and no call has been placed for it yet (exactly one ring,
 * no retries). Every other incident goes to the urgent-event validator.
 */
export function createTestAwareIncidentValidator(
  base: IncidentValidator,
  store: { incident(id: string): { trigger: AlertTrigger; status: string; createdAt: string } | undefined; calls(id: string): unknown[] },
  clock: { nowMs(): number },
): IncidentValidator {
  return {
    revalidate(incidentId) {
      if (!incidentId.startsWith(TEST_CALL_PREFIX)) return base.revalidate(incidentId);
      const inc = store.incident(incidentId);
      if (!inc || inc.trigger !== 'test') return { active: false, reason: 'unknown test call' };
      if (inc.status !== 'active') return { active: false, reason: `test call ${inc.status}` };
      if (store.calls(incidentId).length > 0) return { active: false, reason: 'test call already placed (no retries)' };
      if (clock.nowMs() - Date.parse(inc.createdAt) > TEST_CALL_TTL_MS) return { active: false, reason: 'test call request expired' };
      return { active: true, reason: 'owner-requested test call' };
    },
  };
}
