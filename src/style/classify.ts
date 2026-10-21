/**
 * Heuristic casual vs professional classifier for owner-authored messages.
 * Combines recipient-type hints (work email, group chat) with text features
 * (greetings/sign-offs, vocabulary, slang, emoji, capitalisation).
 */
export type Register = 'casual' | 'professional';
export const REGISTERS: readonly Register[] = ['casual', 'professional'];

export interface RegisterHints {
  chatKind?: 'individual' | 'group' | 'unknown';
  recipientKind?: 'phone' | 'email_personal' | 'email_work' | 'mixed' | 'unknown';
  participantCount?: number;
}

export interface RegisterVerdict {
  register: Register;
  score: number;
  reasons: string[];
}

export const CASUAL_ABBREVIATIONS = [
  'lol', 'lmao', 'lmfao', 'rofl', 'haha', 'hahaha', 'hehe', 'u', 'ur', 'r', 'ya', 'yea', 'yeah', 'yh', 'nah', 'gonna', 'wanna', 'gotta', 'kinda',
  'idk', 'idc', 'tbh', 'ngl', 'fr', 'frfr', 'bro', 'bruh', 'omg', 'wyd', 'hbu', 'wbu', 'rn', 'nvm', 'bet', 'fam', 'smh', 'imo', 'imho', 'btw',
  'ty', 'thx', 'np', 'pls', 'plz', 'k', 'kk', 'ok', 'okk', 'aight', 'ight', 'yo', 'sup', 'lemme', 'gimme', 'dunno', 'cuz', 'cos', 'tho', 'thru',
  'b4', 'gn', 'gm', 'ttyl', 'brb', 'omw', 'asap', 'jk', 'ikr', 'ofc', 'abt', 'w/', 'w/e', 'wtv', 'mb', 'g', 'dawg', 'fs',
] as const;
const SLANG = new Set<string>(['lol', 'lmao', 'lmfao', 'rofl', 'u', 'ur', 'gonna', 'wanna', 'idk', 'tbh', 'ngl', 'fr', 'frfr', 'bro', 'bruh', 'omg', 'wyd', 'hbu', 'wbu', 'rn', 'nvm', 'bet', 'fam', 'smh', 'aight', 'ight', 'yo', 'sup', 'lemme', 'dunno', 'cuz', 'tho', 'jk', 'ikr', 'dawg', 'fs', 'kk', 'mb']);
const PRO_VOCAB =
  /\b(meeting|schedule[ds]?|interview(?:s|ing)?|application|applied|position|role|resume|résumé|cv|invoice|client|deadline|availability|available|professor|prof|instructor|assignment|submission|proposal|contract|appointment|regarding|attached|attachment|follow(?:ing)?[\s-]up|opportunity|payment|quote|estimate|project|deliverable|requirements?|recruiter|hiring|offer|onboarding|team|manager|office|conference|agenda|minutes|report|review|feedback|budget|timeline|sincerely|regards|apologi[sz]e|appreciate)\b/gi;
const FORMAL_GREETING = /^(hi|hello|dear|good\s+(morning|afternoon|evening)|greetings)\b[^\n]{0,40},/i;
const FORMAL_CLOSER = /\b(best regards|kind regards|warm regards|regards|sincerely|best wishes|thank you for your (time|help|consideration)|looking forward to|please let me know|i would appreciate)\b/i;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}'/]+/gu) ?? [];
}

export function classifyRegister(text: string, hints: RegisterHints = {}): RegisterVerdict {
  let score = 0;
  const reasons: string[] = [];
  const add = (n: number, why: string) => {
    score += n;
    reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`);
  };
  const words = tokenize(text);
  if (hints.recipientKind === 'email_work') add(2, 'work/school email recipient');
  if (hints.chatKind === 'group') add(-1, 'group chat');
  if (FORMAL_GREETING.test(text.trim())) add(1.5, 'formal greeting');
  if (FORMAL_CLOSER.test(text)) add(1.5, 'formal sign-off/phrasing');
  const vocab = (text.match(PRO_VOCAB) ?? []).length;
  if (vocab > 0) add(Math.min(vocab, 2), 'work/school vocabulary');
  const trimmed = text.trim();
  if (words.length >= 8 && /^[A-Z]/.test(trimmed) && /[.?]$/.test(trimmed)) add(0.5, 'sentence case with terminal punctuation');
  const slang = words.filter((w) => SLANG.has(w)).length;
  if (slang > 0) add(-Math.min(slang, 3), 'slang/abbreviations');
  if (/\b(ha){2,}h?\b|\bhehe+\b/i.test(text)) add(-1, 'laughter');
  if (EMOJI_RE.test(text)) add(-1, 'emoji');
  if (/[a-z]/.test(trimmed) && trimmed === trimmed.toLowerCase() && words.length >= 2) add(-0.5, 'all lowercase');
  if (words.length < 4) add(-0.5, 'very short');
  return { register: score >= 1.5 ? 'professional' : 'casual', score, reasons };
}
