import type { NormalizedMail } from './types.ts';
import type { InterviewDetection } from './classify.ts';
import { domainOf } from './types.ts';

const TERM = /\b(interviews?|phone screen|technical screen|screening call|hiring manager (?:call|chat)|next round|on[- ]site interview)\b/i;
const REJECTED = /\b(we regret|unfortunately|not (?:be )?moving forward|not proceeding|other candidates|position has been filled|decided to (?:pursue|move forward with) other)\b/i;
const RECEIPT = /\b(received your (?:job )?application|application (?:has been |was )?received|thank you for (?:applying|your (?:interest|application))|if your (?:profile|qualifications)|if (?:you are |you're )?(?:selected|shortlisted))\b/i;
const DISCLAIMER = /\b(if|may|might|should you|only (?:those|candidates)|never|fees?|payment|fraud|scam|tips|how to|privacy|accommodation|accessibility)\b/i;
const DIRECT = /\b(invite (?:you|you to)|inviting you|you (?:are|'re|have been) invited|invitation (?:to|for)|(?:your|the) interview (?:is|has been)|interview (?:confirmed|scheduled)|(?:schedule|arrange|book|confirm) (?:your |an? |the )?(?:\w+[- ]?\s+){0,3}interview|would (?:like|love) to (?:interview|meet|speak|chat|talk)(?: with)? you)\b/i;
const ACTION = /\b(please (?:share|send|confirm|select|choose|book)|your availability|are you available|select a time|pick a time|book a time|schedule|scheduled|confirmed|invitation|invite you|next steps?)\b/i;
const SCHEDULERS = ['calendly.com','goodtime.io','cal.com','hirevue.com','zoom.us','teams.microsoft.com','meet.google.com'];

/** A careers/ATS link and a generic mention of interviews are not an invitation. */
export function detectInterviewEvidence(m: Pick<NormalizedMail,'subject'|'bodyText'|'from'>, bulk: boolean): InterviewDetection {
  const none: InterviewDetection = {detected:false,confidence:'none',evidence:[],schedulingLinks:[],company:null};
  const all = `${m.subject}\n${m.bodyText}`;
  if (!TERM.test(all) || REJECTED.test(all)) return none;
  const urls = all.match(/https?:\/\/[^\s<>"')]+/gi) ?? [];
  const links = [...new Set(urls.filter(raw => {try {const host=new URL(raw).hostname.toLowerCase();return SCHEDULERS.some(d=>host===d||host.endsWith(`.${d}`));}catch{return false;}}))].slice(0,5);
  const clean = (s:string) => s.replace(/https?:\/\/[^\s<>"')]+/gi,' ');
  const clauses = clean(m.bodyText).split(/(?:[.!?](?:\s|$)|\n)+/).map(s=>s.trim()).filter(s=>s&&!DISCLAIMER.test(s));
  const direct = clauses.find(s=>DIRECT.test(s)&&TERM.test(s));
  const receipt = RECEIPT.test(all);
  const subjectInterview = TERM.test(m.subject)&&!DISCLAIMER.test(m.subject);
  const actionable = clauses.find(s=>ACTION.test(s));
  if (receipt&&!direct) return none;
  if (!direct && !(subjectInterview && (actionable || links.length))) return none;
  if (bulk&&!subjectInterview) return none;
  const domain=domainOf(m.from?.address);
  return {detected:true,confidence:subjectInterview&&!bulk?'high':'medium',evidence:[direct?'direct interview invitation':'interview subject with scheduling request',...(links.length?['scheduling link']:[])],schedulingLinks:links,company:domain&&!/(gmail|outlook|hotmail|yahoo|icloud|proton)\./i.test(domain)?domain.split('.').slice(-2,-1)[0]??null:null};
}
