import { CASUAL_ABBREVIATIONS, tokenize, type Register } from './classify.ts';

/**
 * Aggregate writing-style statistics. Only aggregates and short, frequent
 * tokens are kept: openers/closers must appear in several distinct messages
 * and be lowercase function-like words, so names and one-off phrases never
 * end up in a guide.
 */
export interface Distribution {
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  mean: number;
}

export interface StyleStats {
  register: Register;
  count: number;
  words: Distribution;
  chars: Distribution;
  sentencesPerMessage: number;
  capitalization: { startsUppercaseRate: number; allLowercaseRate: number; lowercaseIRate: number; allCapsWordRate: number };
  punctuation: {
    endsWithPeriodRate: number;
    endsWithNoPunctuationRate: number;
    exclamationRate: number;
    questionRate: number;
    ellipsisRate: number;
    commasPerMessage: number;
    multipleExclamationRate: number;
  };
  emoji: { messagesWithEmojiRate: number; perMessage: number; top: { emoji: string; count: number }[] };
  openers: { token: string; rate: number }[];
  closers: { token: string; rate: number }[];
  abbreviations: { token: string; rate: number }[];
  laughter: { token: string; rate: number }[];
  multiMessageBursts?: number;
}

const EMOJI_G = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu;
const OPENER_LEXICON = new Set([
  'hey', 'hi', 'hello', 'yo', 'sup', 'ok', 'okay', 'k', 'kk', 'yes', 'yeah', 'yea', 'ya', 'no', 'nah', 'lol', 'lmao', 'haha', 'omg', 'sure', 'thanks', 'thank',
  'good', 'morning', 'so', 'also', 'and', 'but', 'wait', 'oh', 'ah', 'damn', 'bro', 'bruh', 'dear', 'just', 'i', 'im', "i'm", 'we', 'can', 'did', 'are', 'do',
  'what', 'when', 'where', 'how', 'why', 'is', 'sounds', 'perfect', 'great', 'cool', 'nice', 'np', 'ty', 'thx', 'alright', 'aight', 'gm', 'gn', 'sorry', 'please',
]);
const CLOSER_LEXICON = new Set([
  'thanks', 'thank', 'you', 'thx', 'ty', 'lol', 'lmao', 'haha', 'regards', 'best', 'cheers', 'sincerely', 'later', 'ttyl', 'bye', 'soon', 'ok', 'okay', 'k', 'kk',
  'yeah', 'ya', 'bro', 'bruh', 'fr', 'tho', 'rn', 'tmrw', 'tomorrow', 'today', 'tonight', 'now', 'please', 'pls', 'asap', 'appreciated', 'appreciate', 'it', 'man',
  'g', 'fam', 'good', 'night', 'gn', 'np', 'sure', 'yes', 'no', 'nah', 'lmk', 'xo', 'xx',
]);
const LAUGHTER = /^(lol+|lmao+|lmfao+|rofl|(?:ha){2,}h?|(?:he){2,}|😂|🤣|💀)$/u;

export function distribution(values: number[]): Distribution {
  if (values.length === 0) return { p10: 0, p25: 0, median: 0, p75: 0, p90: 0, mean: 0 };
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { p10: q(0.1), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9), mean: Math.round(mean * 10) / 10 };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function topRates(counts: Map<string, number>, total: number, minCount: number, minRate: number, max: number): { token: string; rate: number }[] {
  return [...counts.entries()]
    .filter(([, c]) => c >= minCount && c / total >= minRate)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([token, c]) => ({ token, rate: r3(c / total) }));
}

export function computeStyleStats(register: Register, texts: string[]): StyleStats {
  const n = texts.length;
  const wordCounts: number[] = [];
  const charCounts: number[] = [];
  let sentences = 0;
  let startsUpper = 0;
  let allLower = 0;
  let lowerI = 0;
  let iTotal = 0;
  let capsWords = 0;
  let totalWords = 0;
  let endPeriod = 0;
  let endNone = 0;
  let excl = 0;
  let multiExcl = 0;
  let quest = 0;
  let ellipsis = 0;
  let commas = 0;
  let withEmoji = 0;
  let emojiTotal = 0;
  const emojiCounts = new Map<string, number>();
  const openers = new Map<string, number>();
  const closers = new Map<string, number>();
  const abbrev = new Map<string, number>();
  const laughs = new Map<string, number>();
  const abbrevSet = new Set<string>(CASUAL_ABBREVIATIONS);

  for (const raw of texts) {
    const t = raw.trim();
    const words = tokenize(t);
    wordCounts.push(words.length);
    charCounts.push([...t].length);
    totalWords += words.length;
    sentences += Math.max(1, (t.match(/[.!?]+(\s|$)/g) ?? []).length);
    const firstLetter = /\p{L}/u.exec(t)?.[0];
    if (firstLetter && firstLetter === firstLetter.toUpperCase() && firstLetter !== firstLetter.toLowerCase()) startsUpper++;
    if (/\p{L}/u.test(t) && t === t.toLowerCase()) allLower++;
    for (const m of t.matchAll(/\b[iI]\b(?!['’][a-z]{2,})/g)) {
      iTotal++;
      if (m[0] === 'i') lowerI++;
    }
    for (const w of t.split(/\s+/)) if (w.length >= 3 && /^[A-Z]+[!?.]*$/.test(w)) capsWords++;
    const noEmojiEnd = t.replace(EMOJI_G, '').trimEnd();
    if (/\.$/.test(noEmojiEnd) && !/\.\.\.$|…$/.test(noEmojiEnd)) endPeriod++;
    if (!/[.!?…)]$/.test(noEmojiEnd)) endNone++;
    if (t.includes('!')) excl++;
    if (/!{2,}/.test(t)) multiExcl++;
    if (t.includes('?')) quest++;
    if (/\.\.\.|…/.test(t)) ellipsis++;
    commas += (t.match(/,/g) ?? []).length;
    const emojis = t.match(EMOJI_G) ?? [];
    if (emojis.length) withEmoji++;
    emojiTotal += emojis.length;
    for (const e of emojis) emojiCounts.set(e, (emojiCounts.get(e) ?? 0) + 1);
    const seenAbbrev = new Set<string>();
    const seenLaugh = new Set<string>();
    for (const w of words) {
      if (abbrevSet.has(w)) seenAbbrev.add(w);
      if (LAUGHTER.test(w)) seenLaugh.add(w.replace(/(ha){3,}/, 'hahaha'));
    }
    for (const e of emojis) if (LAUGHTER.test(e)) seenLaugh.add(e);
    for (const w of seenAbbrev) abbrev.set(w, (abbrev.get(w) ?? 0) + 1);
    for (const w of seenLaugh) laughs.set(w, (laughs.get(w) ?? 0) + 1);
    const first = words[0];
    if (first && OPENER_LEXICON.has(first)) openers.set(first, (openers.get(first) ?? 0) + 1);
    const last = words[words.length - 1];
    if (last && CLOSER_LEXICON.has(last) && words.length > 1) closers.set(last, (closers.get(last) ?? 0) + 1);
  }
  const safe = (x: number) => (n === 0 ? 0 : r3(x / n));
  const minCount = Math.max(3, Math.ceil(n * 0.01));
  return {
    register,
    count: n,
    words: distribution(wordCounts),
    chars: distribution(charCounts),
    sentencesPerMessage: n ? Math.round((sentences / n) * 10) / 10 : 0,
    capitalization: {
      startsUppercaseRate: safe(startsUpper),
      allLowercaseRate: safe(allLower),
      lowercaseIRate: iTotal ? r3(lowerI / iTotal) : 0,
      allCapsWordRate: totalWords ? r3(capsWords / totalWords) : 0,
    },
    punctuation: {
      endsWithPeriodRate: safe(endPeriod),
      endsWithNoPunctuationRate: safe(endNone),
      exclamationRate: safe(excl),
      questionRate: safe(quest),
      ellipsisRate: safe(ellipsis),
      commasPerMessage: n ? Math.round((commas / n) * 100) / 100 : 0,
      multipleExclamationRate: safe(multiExcl),
    },
    emoji: {
      messagesWithEmojiRate: safe(withEmoji),
      perMessage: n ? Math.round((emojiTotal / n) * 100) / 100 : 0,
      top: [...emojiCounts.entries()]
        .filter(([, c]) => c >= minCount)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8)
        .map(([emoji, count]) => ({ emoji, count })),
    },
    openers: topRates(openers, Math.max(n, 1), minCount, 0.02, 8),
    closers: topRates(closers, Math.max(n, 1), minCount, 0.02, 8),
    abbreviations: topRates(abbrev, Math.max(n, 1), minCount, 0.01, 12),
    laughter: topRates(laughs, Math.max(n, 1), minCount, 0.01, 5),
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** A compact natural-language brief (a few lines) suitable for a model prompt. */
export function styleBrief(s: StyleStats): string {
  if (s.count === 0) return `No ${s.register} samples yet; write plainly and briefly.`;
  const lines: string[] = [];
  lines.push(`Length: usually ${s.words.p25}–${s.words.p75} words (median ${s.words.median}); ~${s.sentencesPerMessage} sentence(s).`);
  const cap =
    s.capitalization.allLowercaseRate >= 0.5
      ? `Mostly all-lowercase (${pct(s.capitalization.allLowercaseRate)})`
      : `Starts with a capital ${pct(s.capitalization.startsUppercaseRate)} of the time`;
  lines.push(`${cap}; writes "i" lowercase ${pct(s.capitalization.lowercaseIRate)} of the time.`);
  lines.push(
    `Ending: no final punctuation ${pct(s.punctuation.endsWithNoPunctuationRate)}, period ${pct(s.punctuation.endsWithPeriodRate)}; "!" in ${pct(s.punctuation.exclamationRate)}, "?" in ${pct(s.punctuation.questionRate)}, ellipsis ${pct(s.punctuation.ellipsisRate)}.`,
  );
  if (s.emoji.messagesWithEmojiRate > 0) {
    lines.push(`Emoji in ${pct(s.emoji.messagesWithEmojiRate)} of messages${s.emoji.top.length ? `; favourites ${s.emoji.top.slice(0, 4).map((e) => e.emoji).join(' ')}` : ''}.`);
  } else lines.push('No emoji.');
  if (s.openers.length) lines.push(`Common openers: ${s.openers.slice(0, 5).map((o) => `"${o.token}"`).join(', ')}.`);
  if (s.closers.length) lines.push(`Common last words: ${s.closers.slice(0, 5).map((o) => `"${o.token}"`).join(', ')}.`);
  if (s.abbreviations.length) lines.push(`Abbreviations: ${s.abbreviations.slice(0, 8).map((a) => `${a.token} (${pct(a.rate)})`).join(', ')}.`);
  if (s.laughter.length) lines.push(`Laughs as: ${s.laughter.map((l) => l.token).join(', ')}.`);
  return lines.join('\n');
}
