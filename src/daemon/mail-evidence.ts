import { detectInterview } from '../connectors/mail/classify.ts';
import type { MailStore } from '../connectors/mail/store.ts';
import type { UrgentEvent } from '../notifications/urgent.ts';

/** Reads the cached source again; an earlier category/title is never interview evidence. */
export function mailEventInvalidReason(store: MailStore, event: UrgentEvent): string | null {
  if (!['interview_invitation','business_enquiry'].includes(event.sourceType)) return null;
  const {accountId,messageId}=event.detail;
  if (typeof accountId!=='string'||typeof messageId!=='string') return 'Mail source binding missing';
  const mail=store.get(accountId,messageId);
  if (!mail||mail.deletedAt) return 'Mail source no longer available';
  if (mail.priority!=='priority'||mail.injectionFlagged||mail.classification.bulk) return 'Mail no longer qualifies for urgent attention';
  if (event.sourceType==='interview_invitation') return mail.category==='interview_invitation'&&detectInterview(mail,mail.classification.bulk).detected?null:'Original email does not establish an interview invitation';
  return ['business_enquiry','client_opportunity','company_partnership'].includes(mail.category)?null:'Mail classification changed';
}
