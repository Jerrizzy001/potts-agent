/**
 * Deterministic support classifier. It separates:
 *   - customer_support: an ordinary product question (FAQ, feature, pricing
 *     explanation, troubleshooting, status, info needed to investigate);
 *   - personal_business_opportunity: someone wanting to work with / hire /
 *     partner with the owner — a personal reply that always needs approval;
 *   - protected: anything in the owner-approval list (refunds, credits,
 *     discounts, compensation, promises of fixes/dates, account/billing/
 *     permission/data changes, private information, threats/legal, security
 *     incidents) or text that tries to instruct the assistant;
 *   - unclassified: no confident signal → owner.
 *
 * Customer text is DATA. It can only add restrictions: nothing in it can
 * lower the bar for an automatic reply. An optional extra classifier (e.g. the
 * local model) may add protected reasons but can never remove any.
 */
export type SupportCategory = 'customer_support' | 'personal_business_opportunity' | 'protected' | 'unclassified';

export const PROTECTED_REASONS = [
  'refund_credit_discount_compensation',
  'promise_fix_date_arrangement',
  'account_billing_permission_data_change',
  'private_information',
  'threat_or_legal',
  'security_incident',
  'suspicious_instructions',
] as const;
export type ProtectedReason = (typeof PROTECTED_REASONS)[number];

export interface Classification {
  category: SupportCategory;
  /** Confidence in `category` (0–1). Automatic replies need >= the configured threshold. */
  confidence: number;
  protectedReasons: ProtectedReason[];
  supportSignals: string[];
  businessSignals: string[];
}

const PROTECTED: { reason: ProtectedReason; patterns: RegExp[] }[] = [
  {
    reason: 'refund_credit_discount_compensation',
    patterns: [/\brefund/i, /\bmoney back\b/i, /\bcredits?\b/i, /\bdiscount/i, /\bcoupon|promo code/i, /\bcompensat/i, /\bchargeback/i, /\breimburs/i, /\bpro-?rat/i, /\bwaive/i, /\bfree (month|months|upgrade|extension)\b/i, /\bpay (me|us) back\b/i],
  },
  {
    reason: 'promise_fix_date_arrangement',
    patterns: [
      /\bwhen will\b.{0,40}\b(fix|fixed|ready|available|released|live|back|resolved|ship)/i,
      /\b(eta|deadline|guarantee[ds]?|promise[ds]?|commit(ment)? to)\b/i,
      /\bby (today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|end of|next week)\b/i,
      /\b(special (arrangement|deal|exception|treatment)|make an exception|custom (deal|pricing|plan))\b/i,
    ],
  },
  {
    reason: 'account_billing_permission_data_change',
    patterns: [
      /\b(delete|close|deactivate|cancel|merge|transfer|remove|reactivate|unban|restore)\b.{0,30}\b(account|subscription|plan|data|profile|membership|history)\b/i,
      /\b(change|update|edit|switch)\b.{0,30}\b(e-?mail|password|billing|card|payment|plan|role|permissions?|username|name on)\b/i,
      /\b(upgrade|downgrade)\b/i,
      /\b(give|grant|add|remove|revoke)\b.{0,25}\b(access|admin|permissions?|seat|user)\b/i,
      /\bexport (my|all|our) (data|information)\b/i,
      /\b(gdpr|ccpa|pipeda|data (deletion|access|portability) request)\b/i,
      /\b(invoice|receipt|billing|billed|charged?|overcharged|payment failed|card (was )?declined)\b/i,
    ],
  },
  {
    reason: 'private_information',
    patterns: [
      /\b(ssn|social insurance|social security|credit card number|cvv|one[- ]time code|2fa code|verification code|passcode)\b/i,
      /\b(send|tell|give|share|email|text|what('?s| is)|need|know)\b.{0,20}\bpassword\b(?!\s*(reset|recovery|link|change))/i,
      /\b(other|another|a different) (user|customer|person|member|applicant)('?s)?\b/i,
      /\bwho (else|is)\b.{0,30}\b(using|registered|account|email|behind)\b/i,
      /\b(personal|private|contact) (info|information|data|details)\b/i,
      /\b(e-?mail|phone( number)?|home address|address) (of|for) (the|this|that|a|an|your)\b/i,
    ],
  },
  {
    reason: 'threat_or_legal',
    patterns: [
      /\b(lawyer|attorney|legal action|lawsuit|sue|suing|court|small claims|cease and desist|class action|solicitor)\b/i,
      /\breport (you|this|your (company|app|service)) to\b/i,
      /\b(bbb|better business bureau|regulator|ftc|competition bureau|consumer protection|ombudsman)\b/i,
      /\b(police|scam|scammers?|fraud(ulent)?|illegal)\b/i,
      /\b(threat|or else|you('| wi)ll (regret|pay))\b/i,
    ],
  },
  {
    reason: 'security_incident',
    patterns: [/\b(hacked|breach(ed)?|compromised|unauthori[sz]ed (access|charge|login|transaction)|phishing|stolen|leak(ed)?)\b/i],
  },
  {
    reason: 'suspicious_instructions',
    patterns: [
      /\bignore\b.{0,20}\b(previous|prior|above|earlier|all|your)\b.{0,20}\b(instructions?|messages?|rules|prompt|policy)\b/i,
      /\b(system prompt|developer mode|jailbreak|prompt injection|do anything now)\b/i,
      /\byou are now\b/i,
      /\b(the )?(owner|admin|administrator|ceo|founder|alex)\b.{0,20}\b(has |already )?(approved|authori[sz]ed|allowed|said (it'?s|you can))\b/i,
      /\b(i am|i'm|this is) (the )?(owner|admin|administrator|developer|founder|alex)\b/i,
      /\b(override|bypass|disable|turn off|skip)\b.{0,20}\b(policy|policies|rules|approval|safety|guardrails?|checks?)\b/i,
      /\b(auto(matic(ally)?)?[- ]?(approve|approved|send|reply)|without (owner )?approval)\b/i,
      /<\/?(system|assistant|instructions?)>/i,
    ],
  },
];

const SUPPORT_SIGNALS: [string, RegExp][] = [
  ['how_to', /\b(how (do|can|to|does)|is there a way|where (do|can) i|what does)\b/i],
  ['cannot', /\b(can'?t|cannot|can not|unable to|won'?t let me|doesn'?t let me)\b/i],
  ['error', /\b(error|bug|glitch|crash(es|ed|ing)?|broken|not working|doesn'?t work|isn'?t working|stuck|fails?|failed|failing|blank page|404|500)\b/i],
  ['login', /\b(log ?in|sign ?in|logging in|signing in|forgot( my)? password|reset( my)? password|password reset)\b/i],
  ['feature', /\b(feature|does (it|the app|job finder) support|can (it|the app|i use it to)|integrat(e|ion)|export|upload|resume|cv|cover letter|job alerts?|apply|application tracking)\b/i],
  ['pricing', /\b(pricing|price|prices|cost|how much|plans?|free tier|subscription options|what do (you|i) get)\b/i],
  ['status', /\b(is (it|the site|the app|job finder|exampleapp) down|outage|status|slow|not loading|maintenance)\b/i],
  ['help', /\b(help|support|question|wondering)\b/i],
];

const BUSINESS_SIGNALS: [string, RegExp][] = [
  ['partnership', /\b(partner(ship)?|collaborat(e|ion)|joint venture|co-?market)/i],
  ['sponsorship', /\bsponsor(ship)?\b/i],
  ['investment', /\b(invest(ment|or|ing)?|funding|acqui(re|sition)|buy (your|the) (company|app|business))\b/i],
  ['hire', /\b(hire you|hiring you|freelance|contract(or)? (work|role|position|gig)|consult(ing|ant|ancy)?|work with you|build (us|me) (a|an)|develop (a|an) (app|website|site) for)\b/i],
  ['job', /\b(job offer|job opportunity|interview|recruit(er|ing)|position at|role at|we'?re hiring)\b/i],
  ['business', /\b(business (proposal|opportunity|inquiry|enquiry)|proposal|quote for|your rates|rate card|white[- ]label|resell(er)?|affiliate (program|partnership)|licens(e|ing) (your|the))\b/i],
];

export type ExtraClassifier = (text: string) => Promise<{ protectedReasons: ProtectedReason[] }>;

export function classifySupportMessage(input: { subject?: string; text: string }): Classification {
  const text = `${input.subject ?? ''}\n${input.text}`.normalize('NFKC');
  const protectedReasons = PROTECTED.filter((p) => p.patterns.some((re) => re.test(text))).map((p) => p.reason);
  const supportSignals = SUPPORT_SIGNALS.filter(([, re]) => re.test(text)).map(([n]) => n);
  const businessSignals = BUSINESS_SIGNALS.filter(([, re]) => re.test(text)).map(([n]) => n);
  const base = { protectedReasons, supportSignals, businessSignals };
  if (protectedReasons.length) return { category: 'protected', confidence: 0.9, ...base };
  const s = supportSignals.filter((x) => x !== 'help').length + (supportSignals.includes('help') ? 0.5 : 0);
  const b = businessSignals.length;
  if (b === 0 && s === 0) return { category: 'unclassified', confidence: 0, ...base };
  if (b > 0 && s === 0) return { category: 'personal_business_opportunity', confidence: Math.min(0.95, 0.6 + 0.1 * b), ...base };
  if (s > 0 && b === 0) return { category: 'customer_support', confidence: Math.min(0.95, 0.55 + 0.15 * s), ...base };
  // Mixed signals: ambiguous by construction, never above an automatic threshold.
  return b >= s ? { category: 'personal_business_opportunity', confidence: 0.5, ...base } : { category: 'customer_support', confidence: 0.5, ...base };
}

/** Runs the deterministic classifier, then lets an extra classifier ADD protected reasons only. */
export async function classifyWithExtra(input: { subject?: string; text: string }, extra?: ExtraClassifier): Promise<Classification> {
  const c = classifySupportMessage(input);
  if (!extra) return c;
  let added: ProtectedReason[] = [];
  try {
    added = (await extra(input.text)).protectedReasons.filter((r) => (PROTECTED_REASONS as readonly string[]).includes(r));
  } catch {
    // A failing extra classifier makes the message unclassifiable → owner.
    return { ...c, category: c.category === 'protected' ? 'protected' : 'unclassified', confidence: 0 };
  }
  const reasons = [...new Set([...c.protectedReasons, ...added])];
  if (reasons.length === c.protectedReasons.length) return c;
  return { ...c, category: 'protected', confidence: 0.9, protectedReasons: reasons };
}
