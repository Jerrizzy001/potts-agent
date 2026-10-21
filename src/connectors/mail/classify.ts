import { detectInjection, type InjectionReport } from './injection.ts';
import { domainOf, type NormalizedMail } from './types.ts';

/**
 * Categories from the operating spec. Priority: companies seeking to work with
 * the owner, business enquiries, client opportunities, job and interview
 * opportunities. Routine (briefing only): newsletters, receipts, promotions,
 * automated notifications, job-alert digests.
 */
export const MAIL_CATEGORIES = [
  'interview_invitation', 'job_opportunity', 'business_enquiry', 'client_opportunity', 'company_partnership',
  'school', 'personal', 'other',
  'newsletter', 'receipt', 'promotion', 'notification', 'job_alert',
] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number];
export type MailPriority = 'priority' | 'normal' | 'routine';

export const PRIORITY_CATEGORIES: readonly MailCategory[] = ['interview_invitation', 'job_opportunity', 'business_enquiry', 'client_opportunity', 'company_partnership'];
export const ROUTINE_CATEGORIES: readonly MailCategory[] = ['newsletter', 'receipt', 'promotion', 'notification', 'job_alert'];

export function priorityOf(c: MailCategory): MailPriority {
  if (PRIORITY_CATEGORIES.includes(c)) return 'priority';
  if (ROUTINE_CATEGORIES.includes(c)) return 'routine';
  return 'normal';
}

export interface InterviewDetection {
  detected: boolean;
  confidence: 'high' | 'medium' | 'none';
  evidence: string[];
  schedulingLinks: string[];
  company: string | null;
}

export interface MailClassification {
  category: MailCategory;
  priority: MailPriority;
  reasons: string[];
  bulk: boolean;
  interview: InterviewDetection;
  injection: InjectionReport;
  /** Set when a model refined the heuristic category. */
  modelCategory?: MailCategory;
}

export interface ClassifierOptions {
  /** Owner's own school domains (treated as 'school' when nothing stronger matches). */
  schoolDomains?: string[];
}

const RX = {
  receipt: /\b(receipt|order confirm(ation|ed)|your order|order (#|no\.?|number)|invoice|payment (received|confirmation|successful)|purchase confirmation|billing statement|transaction (details|receipt)|you(?:'ve| have) paid|refund (issued|processed))\b/i,
  promotion: /(\b\d{1,2}% off\b|\bsale\b|\bdeals?\b|\bdiscount\b|\bcoupon\b|\bpromo(tion)? code\b|\blimited[- ]time\b|\bshop now\b|\bfree shipping\b|\bexclusive offer\b|\bblack friday\b|\bcyber monday\b|\bsave (up to )?\$?\d+)/i,
  newsletter: /\b(newsletter|digest|weekly|monthly|edition|issue #?\d+|roundup|this week in|bulletin)\b/i,
  notification: /\b(security alert|new sign[- ]in|password (was )?changed|verify your email|verification code|your code is|notification|reminder:|has been shipped|delivery update|was delivered)\b/i,
  jobAlert: /\b(job alerts?|new jobs? (for you|matching)|jobs you may be interested in|recommended jobs|\d+ new jobs?)\b/i,
  job: /\b(recruit(er|ing|ment)|hiring|job (opening|opportunity|offer)|(open |exciting )?(position|role) (at|with|for)|your (resume|résumé|cv|application|candidacy)|application (status|update|received)|offer letter|talent acquisition|we('re| are) looking for a)\b/i,
  business: /\b(enquir(y|ies)|inquir(y|ies)|interested in (your|working with you|hiring you)|(request|requesting) (for )?(a )?(quote|quotation|proposal|estimate)|pricing (for|of)|your rates|book your services|hire you|services? you offer|can you help (us|our company))\b/i,
  client: /\b(freelance|contract (work|role|position|developer)|project (budget|scope|proposal|brief)|rfp|request for proposal|statement of work|\bsow\b|retainer|budget (of|is)|paid project|client project)\b/i,
  partnership: /\b(partner(ship)? (with|opportunit(y|ies))|collaborat(e|ion|ing)( with you)?|work (together|with you)|sponsor(ship)?|joint venture|would love to (work|team up)|team up)\b/i,
  school: /\b(assignment|course|professor|instructor|lecture|syllabus|midterm|final exam|grade(s|d)?|semester|tuition|registrar)\b/i,
  interviewTerm: /\b(interview(s|ing)?|phone screen|technical screen|screening call|hiring manager (call|chat)|next round|on-?site (visit|interview))\b/i,
  interviewCue: /\b(invite|invitation|invited|schedule|scheduling|availability|available (for|to)|book a time|select a time|pick a time|time slot|let us know (when|your)|would like to (speak|meet|chat|talk)|set up a (call|time|meeting)|confirm(ed)? (your|the) interview|move (you )?forward|next steps?)\b/i,
  interviewNegative: /\b(interview tips|how to (ace|prepare for) (an|your) interview|we regret|not (be )?moving forward|unfortunately,? we|position has been filled|decided to (pursue|move forward with) other)\b/i,
};
const SCHEDULING_HOSTS = /(calendly\.com|goodtime\.io|greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workday\.com|smartrecruiters\.com|zoom\.us|teams\.microsoft\.com|meet\.google\.com|cal\.com|hirevue\.com)/i;
const BULK_SENDER = /^(newsletter|news|marketing|promo(tions)?|offers|deals|digest|updates|hello|info|mailer|noreply-marketing)@/i;
const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|notifications?|alerts?|mailer-daemon|postmaster|accounts?|billing|receipts?|orders?)@/i;
const JOB_BOARD_DOMAINS = /(linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|monster\.(com|ca)|workopolis\.com|jobbank\.gc\.ca)$/i;

function hits(re: RegExp, subject: string, body: string): number {
  return (re.test(subject) ? 2 : 0) + (re.test(body) ? 1 : 0);
}

export function detectInterview(m: Pick<NormalizedMail, 'subject' | 'bodyText' | 'from'>, bulk: boolean): InterviewDetection {
  const none: InterviewDetection = { detected: false, confidence: 'none', evidence: [], schedulingLinks: [], company: null };
  const text = `${m.subject}\n${m.bodyText}`;
  const links = [...new Set((text.match(/https?:\/\/[^\s<>"')]+/gi) ?? []).filter((u) => SCHEDULING_HOSTS.test(u)))].slice(0, 5);
  const term = RX.interviewTerm.exec(text);
  if (!term || RX.interviewNegative.test(text)) return none;
  const cue = RX.interviewCue.exec(text);
  if (!cue && links.length === 0) return none;
  if (bulk && !RX.interviewTerm.test(m.subject)) return none; // newsletters mentioning interviews
  const evidence = [term[0], ...(cue ? [cue[0]] : []), ...(links.length ? ['scheduling link'] : [])];
  const subjectHas = RX.interviewTerm.test(m.subject);
  const d = domainOf(m.from?.address);
  const company = d && !/(gmail|outlook|hotmail|yahoo|icloud|proton)\./i.test(d) ? d.split('.').slice(-2, -1)[0] ?? null : null;
  return { detected: true, confidence: subjectHas && (cue || links.length) && !bulk ? 'high' : 'medium', evidence, schedulingLinks: links, company };
}

/**
 * Deterministic heuristic classifier. Sender-claimed urgency ("URGENT",
 * "ASAP") is ignored for priority. Content with injection flags is never
 * promoted to `priority` (it is surfaced as `normal` for owner review), so a
 * crafted email cannot trigger an urgent alert by itself.
 */
export function classifyMail(m: NormalizedMail, o: ClassifierOptions = {}): MailClassification {
  const reasons: string[] = [];
  const subject = m.subject ?? '';
  const body = m.bodyText ?? '';
  const h = m.headers;
  const fromAddr = m.from?.address ?? '';
  const fromDomain = domainOf(fromAddr);
  const injection = detectInjection(subject, body, m.from?.name ?? '');
  for (const f of m.contentFlags ?? []) {
    if (!injection.patterns.includes(f)) injection.patterns.push(f);
    injection.flagged = true;
    if (f.startsWith('hidden')) injection.hiddenText = true;
  }

  const listHeaders = !!(h['list-unsubscribe'] || h['list-id']);
  const precedenceBulk = /^(bulk|list|junk)$/i.test(h['precedence'] ?? '');
  const bulk = listHeaders || precedenceBulk || BULK_SENDER.test(fromAddr) || !!h['feedback-id'] || !!h['x-campaign'];
  const automated = AUTOMATED_SENDER.test(fromAddr) || /^auto-(generated|replied)/i.test(h['auto-submitted'] ?? '');
  if (listHeaders) reasons.push('has List-Unsubscribe/List-Id');
  if (precedenceBulk) reasons.push('Precedence: bulk');
  if (automated) reasons.push('automated sender');

  const interview = detectInterview(m, bulk);
  let category: MailCategory = 'other';

  const score = {
    receipt: hits(RX.receipt, subject, body),
    promotion: hits(RX.promotion, subject, body),
    newsletter: hits(RX.newsletter, subject, body),
    notification: hits(RX.notification, subject, body),
    jobAlert: hits(RX.jobAlert, subject, body) + (JOB_BOARD_DOMAINS.test(fromDomain) && bulk ? 2 : 0),
    job: hits(RX.job, subject, body),
    business: hits(RX.business, subject, body),
    client: hits(RX.client, subject, body),
    partnership: hits(RX.partnership, subject, body),
    school: hits(RX.school, subject, body),
  };

  if (interview.detected) {
    category = 'interview_invitation';
    reasons.push(`interview invitation (${interview.confidence}): ${interview.evidence.join(', ')}`);
  } else if (score.receipt >= 2 || (score.receipt >= 1 && automated)) {
    category = 'receipt';
    reasons.push('receipt/order keywords');
  } else if (bulk) {
    if (score.jobAlert >= 2) category = 'job_alert';
    else if (score.promotion >= score.newsletter && score.promotion > 0) category = 'promotion';
    else if (score.notification >= 2) category = 'notification';
    else category = 'newsletter';
    reasons.push(`bulk mail → ${category}`);
  } else if (score.notification >= 2 && automated) {
    category = 'notification';
    reasons.push('automated notification');
  } else if (score.promotion >= 2 && automated) {
    category = 'promotion';
    reasons.push('promotional keywords from automated sender');
  } else {
    const ranked = (
      [
        ['client_opportunity', score.client],
        ['business_enquiry', score.business],
        ['company_partnership', score.partnership],
        ['job_opportunity', score.job],
      ] as [MailCategory, number][]
    ).sort((a, b) => b[1] - a[1]);
    const [best, s] = ranked[0]!;
    if (s > 0 && !automated) {
      category = best;
      reasons.push(`${best.replace(/_/g, ' ')} keywords (score ${s})`);
    } else if (s >= 2 && automated && best === 'job_opportunity') {
      category = 'job_opportunity';
      reasons.push('application/recruiting update from automated sender');
    } else if ((o.schoolDomains ?? []).some((d) => fromDomain === d || fromDomain.endsWith('.' + d)) || (score.school >= 2 && !automated)) {
      category = 'school';
      reasons.push('school sender or course keywords');
    } else if (automated) {
      category = 'notification';
      reasons.push('automated sender, no other signal');
    } else {
      category = 'personal';
      reasons.push('individual sender, no category signal');
    }
  }

  let priority = priorityOf(category);
  if (injection.urgencyClaimed) reasons.push('sender claims urgency (ignored for priority)');
  if (injection.flagged) {
    reasons.push(`suspicious content: ${injection.patterns.join(', ')}`);
    if (priority === 'priority') {
      priority = 'normal';
      reasons.push('priority withheld because content contains instruction/authority patterns; owner review');
    }
  }
  return { category, priority, reasons, bulk, interview, injection };
}

/** Category set a model may choose from; validated strictly. */
export function isMailCategory(v: unknown): v is MailCategory {
  return typeof v === 'string' && (MAIL_CATEGORIES as readonly string[]).includes(v);
}
