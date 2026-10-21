/**
 * Sensitive-content detection and PII scrubbing for text that may enter local
 * memory or the style corpus.
 *
 * detectSensitive() is deliberately conservative: a message that *might* hold
 * a credential, one-time code, payment card, government id, bank detail,
 * tokenised link or a street address is excluded entirely (losing a few
 * harmless messages is cheap; storing a credential is not).
 *
 * scrubPii() replaces contact details and long numbers in text that is kept.
 */

export type SensitiveReason =
  | 'otp_code'
  | 'credential'
  | 'secret_token'
  | 'token_url'
  | 'card_number'
  | 'government_id'
  | 'bank_account'
  | 'street_address';

export interface SensitiveVerdict {
  sensitive: boolean;
  reasons: SensitiveReason[];
}

const OTP_CONTEXT =
  /\b(code|codes|otp|passcode|pin|verification|verify|verifying|2fa|mfa|one[-\s]?time|security\s+code|auth(?:entication)?\s+code|login\s+code|sign[-\s]?in\s+code|confirmation\s+code|access\s+code|token)\b/i;
const OTP_VALUE = /(?:\b[A-Z]{1,3}-)?\b\d{4,8}\b|\b\d{3}[\s-]\d{3}\b|\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8}\b/;
const BARE_CODE = /^\s*(?:[A-Z]{1,3}-)?\d{4,8}\s*$|^\s*\d{3}[\s-]\d{3}\s*$/;

const CREDENTIAL =
  /\b(pass(?:word|wd|code|phrase)s?|pwd|p\/w|pw\s*[:=]|pin\s*(?:is|[:=#]|code|number|num)|security\s+(?:question|answer)|recovery\s+(?:code|key|phrase)|backup\s+codes?|seed\s+phrase|mnemonic|private\s+key|api[\s_-]?key|secret\s+key|access\s+key|client\s+secret|login\s+(?:is|details|info|credentials)|credentials?|username\s*(?:is|[:=])|user\s*name\s*(?:is|[:=])|wi-?fi\s+(?:password|pass|pw|code|key))(?![a-z])/i;

const SECRET_TOKEN_PREFIX =
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[abpsr]-[A-Za-z0-9-]{10,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b|\b\d{6,12}:[A-Za-z0-9_-]{30,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]*[^\s<>"')\].,!?;:]/gi;
const TOKEN_PARAM =
  /[?&#](?:[^=&#\s]*?)(token|key|sig|signature|auth|code|session|sid|otp|pwd|pass|password|secret|access|reset|magic|invite|login|ticket|jwt|nonce|state|hash|credential)[^=&#\s]*=/i;

const GOV_ID =
  /\b\d{3}-\d{2}-\d{4}\b|\b\d{3}[\s-]\d{3}[\s-]\d{3}\b|\b(?:sin|ssn|social\s+insurance|social\s+security|passport|health\s+card|ohip|driver'?s?\s+licen[cs]e|licen[cs]e\s+number)\b[^\n]{0,30}\d{3,}/i;

const BANK =
  /\b(?:account\s+(?:number|no\.?|#)|acct\s*(?:no\.?|#|number)?|transit\s+(?:number|no\.?|#)|institution\s+(?:number|no\.?)|routing\s+(?:number|no\.?)|iban|swift|bic|e-?transfer\s+(?:password|answer))\b[^\n]{0,20}[\dA-Z]{3,}|\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b|\b(?:cvv|cvc|cvv2|security\s+code\s+on)\b/i;

const STREET_SUFFIX =
  '(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|cres|crescent|way|pl|place|pkwy|parkway|hwy|highway|trail|trl|terrace|terr|circle|cir|sq|square|gate|grove|gardens|heights|line|sideroad|concession)';
const STREET_ADDRESS = new RegExp(String.raw`\b\d{1,6}[A-Za-z]?\s+(?:[A-Za-z0-9'.-]+\s+){0,4}` + STREET_SUFFIX + String.raw`\b\.?`, 'i');
const UNIT = /\b(?:apt|apartment|unit|suite|ste|po\s+box|p\.o\.\s*box)\s*#?\s*\d+/i;
const POSTAL = /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\s?\d[ABCEGHJ-NPRSTV-Z]\d\b|\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\s+\d{5}(?:-\d{4})?\b/;

function luhnOk(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text: string): boolean {
  const re = /\b\d(?:[\s-]?\d){12,18}\b/g;
  for (const m of text.matchAll(re)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits) && !/^(\d)\1+$/.test(digits)) return true;
  }
  return false;
}

function shannonBitsPerChar(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Long, mixed, high-entropy strings outside URLs (API keys, session ids, recovery strings). */
function hasRandomToken(text: string): boolean {
  const noUrls = text.replace(URL_RE, ' ');
  for (const m of noUrls.matchAll(/[A-Za-z0-9_+/=-]{20,}/g)) {
    const t = m[0];
    const kinds = (/[a-z]/.test(t) ? 1 : 0) + (/[A-Z]/.test(t) ? 1 : 0) + (/\d/.test(t) ? 1 : 0);
    if (kinds >= 2 && /\d/.test(t) && shannonBitsPerChar(t) >= 3.5) return true;
  }
  return false;
}

function hasTokenUrl(text: string): boolean {
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0];
    if (TOKEN_PARAM.test(url)) return true;
    // Path segments that look like one-time tokens (password reset, magic links).
    for (const seg of url.split(/[/?#&=]/)) {
      if (seg.length >= 24 && /\d/.test(seg) && /[A-Za-z]/.test(seg) && shannonBitsPerChar(seg) >= 3.8) return true;
    }
  }
  return false;
}

export function detectSensitive(text: string): SensitiveVerdict {
  const reasons = new Set<SensitiveReason>();
  if (BARE_CODE.test(text) || (OTP_CONTEXT.test(text) && OTP_VALUE.test(text))) reasons.add('otp_code');
  if (CREDENTIAL.test(text)) reasons.add('credential');
  if (SECRET_TOKEN_PREFIX.test(text) || hasRandomToken(text)) reasons.add('secret_token');
  if (hasTokenUrl(text)) reasons.add('token_url');
  if (hasCardNumber(text)) reasons.add('card_number');
  if (GOV_ID.test(text)) reasons.add('government_id');
  if (BANK.test(text)) reasons.add('bank_account');
  if (STREET_ADDRESS.test(text) || UNIT.test(text) || POSTAL.test(text)) reasons.add('street_address');
  return { sensitive: reasons.size > 0, reasons: [...reasons] };
}

export interface ScrubResult {
  text: string;
  replacements: number;
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /(?<![\w])(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?![\w])/g;
const INTL_PHONE_RE = /(?<![\w])\+\d{1,3}(?:[\s.-]?\d{2,4}){2,5}(?![\w])/g;
const LONG_NUMBER_RE = /\b\d{5,}\b/g;
const HANDLE_RE = /(?<![\w@])@[A-Za-z0-9_]{3,30}\b/g;

/** Replaces emails, URLs, phone numbers, @handles and long numbers with placeholders. */
export function scrubPii(text: string): ScrubResult {
  let n = 0;
  const rep = (label: string) => () => {
    n++;
    return label;
  };
  let out = text.replace(URL_RE, rep('[link]'));
  out = out.replace(EMAIL_RE, rep('[email]'));
  out = out.replace(INTL_PHONE_RE, rep('[phone]'));
  out = out.replace(PHONE_RE, rep('[phone]'));
  out = out.replace(HANDLE_RE, rep('[handle]'));
  out = out.replace(LONG_NUMBER_RE, rep('[number]'));
  return { text: out, replacements: n };
}
