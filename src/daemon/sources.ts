/**
 * Adapters from WP-4 readers to WP-5 scheduler/deadline/briefing interfaces.
 * Readers stay read-only; these adapters only translate result shapes.
 */
import type { SyncResult, SyncSource } from '../jobs/standard.ts';
import type { MailPriorityCategory, PriorityMailItem, PriorityMailSource } from '../notifications/deadlines.ts';
import type { MailStore } from '../connectors/mail/store.ts';
import type { MailSyncResult } from '../connectors/mail/sync-common.ts';

export function mailSyncSource(reader: { accountId: string; sync(): Promise<MailSyncResult> }, label: string): SyncSource {
  return {
    id: `${reader.accountId}.mail`,
    kind: 'mail',
    label,
    async sync(): Promise<SyncResult> {
      const r = await reader.sync();
      switch (r.status) {
        case 'ok':
          return { status: 'ok', newItems: r.inserted };
        case 'stale_auth':
          return { status: 'auth_expired' };
        case 'rate_limited':
          return { status: 'rate_limited', retryAfterMs: r.error?.retryAfterMs ?? 15 * 60_000 };
        case 'paused':
        case 'revoked':
          // The owner's control is the reason; status is visible in /pstatus. Do not back off noisily.
          return { status: 'ok', newItems: 0 };
        case 'admin_consent_required':
          return { status: 'error', message: r.error?.message ?? 'admin consent required', retryable: false };
        default:
          return { status: 'error', message: r.error?.message ?? `sync ${r.status}`, retryable: true };
      }
    },
  };
}

const PRIORITY_MAP: Record<string, MailPriorityCategory> = {
  interview_invitation: 'interview_invitation',
  business_enquiry: 'business_enquiry',
  client_opportunity: 'client_opportunity',
  company_partnership: 'business_enquiry',
  job_opportunity: 'job_opportunity',
};

/**
 * Priority mail for deadline alerts and briefings. Only classifier-assigned
 * structured fields decide; text that claims urgency or authority does not.
 * A message flagged for prompt injection or sent in bulk never qualifies.
 */
export function mailPrioritySource(store: MailStore): PriorityMailSource {
  return {
    async listPriorityItems(sinceIso: string): Promise<PriorityMailItem[]> {
      return store
        .list({ priority: 'priority', sinceIso, limit: 200 })
        .filter((m) => PRIORITY_MAP[m.category])
        .map((m) => ({
          id: m.providerMessageId,
          accountId: m.accountId,
          category: PRIORITY_MAP[m.category]!,
          qualifies: !m.injectionFlagged && !m.classification.bulk,
          subject: m.subject,
          from: m.from?.address ?? 'unknown sender',
          receivedAt: m.receivedAt ?? m.firstSeenAt,
        }));
    },
  };
}
