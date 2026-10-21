/**
 * Bridges the WP-5 outbox (at-most-once delivery) to the WP-2 OwnerChannel
 * (the potts-broker plugin's owner-channel socket inside the OpenClaw gateway).
 *
 * - `approval_request` notifications carry the approval id as eventRef; they
 *   are delivered with notifyApproval so the plugin renders the exact content
 *   and bound buttons itself. Potts never formats approval buttons.
 * - Transport "unavailable" before anything was written is a definitive
 *   rejection (retryable); anything else is uncertain (never re-sent).
 */
import type { OwnerChannel as PluginOwnerChannel } from '../owner/owner-channel.ts';
import { OwnerChannelDeferredError, OwnerChannelRejectedError, type OwnerChannel, type OwnerMessage } from '../notifications/channel.ts';
import type { Outbox } from '../notifications/outbox.ts';
import type { ApprovalStore } from '../approvals/store.ts';
import { OWNER_TEXT_LIMIT } from '../owner/owner-channel.ts';
import type { Clock } from '../core/clock.ts';
import { localHhmm } from '../jobs/tz.ts';

function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

export function outboxChannelFromPlugin(ch: PluginOwnerChannel): OwnerChannel {
  return {
    name: `plugin:${ch.kind}`,
    async send(msg: OwnerMessage): Promise<{ providerMessageId: string | null }> {
      if (msg.category === 'approval_request' && msg.text.startsWith('approval:')) {
        const approvalId = msg.text.slice('approval:'.length).split(/\s/)[0]!;
        const r = await ch.notifyApproval(approvalId);
        if (!r.ok) {
          if ((r.error.details as { reason?: string } | undefined)?.reason === 'unavailable') throw new OwnerChannelRejectedError(r.error.message, { retryAfterMs: 60_000 });
          if (r.error.code === 'invalid_input') throw new OwnerChannelRejectedError(r.error.message, { permanent: true });
          throw new Error(r.error.message);
        }
        if (!r.value.messageId && r.value.accepted !== true) throw new Error('Approval delivery is unconfirmed');
        return { providerMessageId: r.value.messageId };
      }
      const parts = splitText(msg.text, OWNER_TEXT_LIMIT);
      let last: string | null = null;
      for (let i = 0; i < parts.length; i++) {
        const r = await ch.notify({ text: parts[i]!, ...(msg.quietHours ? { quietHours:msg.quietHours } : {}),...(msg.expectedDestination?{expectedDestination:msg.expectedDestination}:{}) });
        if (!r.ok) {
          const heldUntil = r.error.details?.notBeforeMs;
          if (i === 0 && r.error.code === 'held' && typeof heldUntil === 'number' && Number.isFinite(heldUntil)) throw new OwnerChannelDeferredError(heldUntil);
          const unavailable = (r.error.details as { reason?: string } | undefined)?.reason === 'unavailable';
          if (i === 0 && unavailable) throw new OwnerChannelRejectedError(r.error.message, { retryAfterMs: 60_000 });
          if (i === 0 && r.error.code === 'invalid_input') throw new OwnerChannelRejectedError(r.error.message, { permanent: true });
          throw new Error(`owner channel failed after ${i} part(s): ${r.error.message}`);
        }
        if (!r.value.messageId && r.value.accepted !== true) throw new Error('Owner message delivery is unconfirmed');
        last = r.value.messageId;
      }
      return { providerMessageId: last };
    },
  };
}

/** Channel used when no owner channel is configured: every send is a retryable rejection (messages wait in the outbox). */
export const unavailableOwnerChannel: OwnerChannel = {
  name: 'none',
  async send() {
    throw new OwnerChannelRejectedError('no owner channel configured', { retryAfterMs: 15 * 60_000 });
  },
};

/**
 * Queues one approval prompt per pending approval (dedup "approval:<id>").
 * The outbox holds them in quiet hours and drops them if the approval is no
 * longer pending when they would be sent.
 */
export function createApprovalNotifier(o: { approvals: ApprovalStore; outbox: Outbox; clock: Clock; timezone: string }) {
  o.outbox.setValidator('approval_request', (n) => {
    if (!n.eventRef) return { deliver: false, reason: 'no approval reference' };
    const a = o.approvals.get(n.eventRef);
    if (!a) return { deliver: false, reason: 'approval no longer exists' };
    if (a.status !== 'pending') return { deliver: false, reason: `approval is ${a.status}` };
    if (Date.parse(a.expiresAt) <= o.clock.nowMs()) return { deliver: false, reason: 'approval expired' };
    return { deliver: true };
  });
  return {
    /** Returns the number of newly queued prompts. */
    scan(): number {
      let n = 0;
      for (const a of o.approvals.listPending()) {
        const r = o.outbox.enqueue({
          dedupKey: `approval:${a.id}`,
          category: 'approval_request',
          // The plugin renders the content; this text only carries the id (and is never shown if delivery uses notifyApproval).
          text: `approval:${a.id} (requested ${localHhmm(Date.parse(a.createdAt), o.timezone)})`,
          eventRef: a.id,
          expiresAtMs: Date.parse(a.expiresAt),
        });
        if (!r.duplicate) n++;
      }
      return n;
    },
  };
}
