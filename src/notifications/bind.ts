import type { Outbox, NotificationCategory, NotificationValidator } from './outbox.ts';
import type { UrgentEvent, UrgentEventStore } from './urgent.ts';

/** Category used for the owner message about an urgent event. */
export function categoryForEvent(ev: UrgentEvent): NotificationCategory {
  if (ev.sourceType === 'monitor_auth') return 'routine';
  return ev.shouldCall ? 'urgent' : 'important';
}

export function eventMessage(ev: UrgentEvent): string {
  const lines = [`${ev.shouldCall ? 'URGENT' : 'Heads-up'}: ${ev.title}`];
  const d = ev.detail;
  if (typeof d.summary === 'string') lines.push(d.summary);
  lines.push(`Ref: ${ev.id}`);
  if (ev.shouldCall) lines.push('Reply "ack" to acknowledge.');
  return lines.join('\n');
}

/**
 * Wires urgent events to the outbox: every newly raised event enqueues one
 * owner notification (dedup "urgent:<event dedup key>"), and the urgent /
 * important validators drop held messages whose event was acknowledged or
 * resolved in the meantime (no stale 08:00 messages).
 */
export function bindUrgentEventsToOutbox(urgent: UrgentEventStore, outbox: Outbox): void {
  urgent.onChange((ev, change) => {
    if (change !== 'raised') return;
    outbox.enqueue({ dedupKey: `urgent:${ev.dedupKey}`, category: categoryForEvent(ev), text: eventMessage(ev), eventRef: ev.id });
  });
  const validator: NotificationValidator = (n) => {
    if (!n.eventRef || !n.eventRef.startsWith('urg_')) return { deliver: true };
    const ev = urgent.get(n.eventRef);
    if (!ev) return { deliver: false, reason: 'event no longer exists' };
    if (ev.status === 'acknowledged') return { deliver: false, reason: 'event already acknowledged' };
    if (ev.status === 'resolved') return { deliver: false, reason: `event resolved (${ev.resolution ?? 'resolved'})` };
    return { deliver: true };
  };
  outbox.setValidator('urgent', validator);
  outbox.setValidator('important', validator);
}
