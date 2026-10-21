import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Register } from './classify.ts';
import { styleBrief, type StyleStats } from './stats.ts';

/**
 * Style guides are written into the Potts home ($POTTS_HOME/style/), never the
 * repository. They hold aggregate statistics only — no message text — so they
 * can be attached to a drafting prompt without leaking conversations.
 */
export function styleDir(home: string): string {
  return join(home, 'style');
}

export function guidePath(home: string, register: Register): string {
  return join(styleDir(home), `${register}.md`);
}

export function statsPath(home: string): string {
  return join(styleDir(home), 'stats.json');
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function renderStyleGuide(s: StyleStats, builtAt: string): string {
  const title = s.register === 'casual' ? 'Casual texting style' : 'Professional writing style';
  const out: string[] = [
    `# ${title}`,
    '',
    `Generated ${builtAt} from ${s.count} of the owner's own ${s.register} messages (aggregate statistics only; no message text).`,
    'Use this to draft in the owner\'s voice. Never invent facts or commitments; never imitate other people.',
    '',
    '## Brief',
    '',
    styleBrief(s),
    '',
    '## Details',
    '',
    `- Words per message: p10 ${s.words.p10}, p25 ${s.words.p25}, median ${s.words.median}, p75 ${s.words.p75}, p90 ${s.words.p90} (mean ${s.words.mean})`,
    `- Characters per message: median ${s.chars.median}, p90 ${s.chars.p90}`,
    `- Capitalisation: starts uppercase ${pct(s.capitalization.startsUppercaseRate)}, all lowercase ${pct(s.capitalization.allLowercaseRate)}, lowercase "i" ${pct(s.capitalization.lowercaseIRate)}, ALL-CAPS words ${pct(s.capitalization.allCapsWordRate)}`,
    `- Punctuation: ends with period ${pct(s.punctuation.endsWithPeriodRate)}, no end punctuation ${pct(s.punctuation.endsWithNoPunctuationRate)}, "!" ${pct(s.punctuation.exclamationRate)} ("!!" ${pct(s.punctuation.multipleExclamationRate)}), "?" ${pct(s.punctuation.questionRate)}, ellipsis ${pct(s.punctuation.ellipsisRate)}, commas/message ${s.punctuation.commasPerMessage}`,
    `- Emoji: ${pct(s.emoji.messagesWithEmojiRate)} of messages, ${s.emoji.perMessage}/message${s.emoji.top.length ? `; top ${s.emoji.top.map((e) => e.emoji).join(' ')}` : ''}`,
    `- Openers: ${s.openers.map((o) => `${o.token} ${pct(o.rate)}`).join(', ') || 'none frequent'}`,
    `- Last words: ${s.closers.map((o) => `${o.token} ${pct(o.rate)}`).join(', ') || 'none frequent'}`,
    `- Abbreviations: ${s.abbreviations.map((o) => `${o.token} ${pct(o.rate)}`).join(', ') || 'none frequent'}`,
    `- Laughter: ${s.laughter.map((o) => o.token).join(', ') || 'none frequent'}`,
    '',
  ];
  return out.join('\n');
}

function writePrivate(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function writeStyleGuides(home: string, stats: Record<Register, StyleStats>, builtAt: string): string[] {
  const dir = styleDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const paths: string[] = [];
  for (const reg of ['casual', 'professional'] as const) {
    const p = guidePath(home, reg);
    writePrivate(p, renderStyleGuide(stats[reg], builtAt));
    paths.push(p);
  }
  writePrivate(statsPath(home), JSON.stringify({ builtAt, stats }, null, 2) + '\n');
  paths.push(statsPath(home));
  return paths;
}

export function loadStyleStats(home: string): Record<Register, StyleStats> | null {
  const p = statsPath(home);
  if (!existsSync(p)) return null;
  try {
    return (JSON.parse(readFileSync(p, 'utf8')) as { stats: Record<Register, StyleStats> }).stats;
  } catch {
    return null;
  }
}

/** Removes generated guides (used after a source revocation leaves them stale). */
export function removeStyleGuides(home: string): string[] {
  const removed: string[] = [];
  for (const p of [guidePath(home, 'casual'), guidePath(home, 'professional'), statsPath(home)]) {
    if (existsSync(p)) {
      rmSync(p, { force: true });
      removed.push(p);
    }
  }
  return removed;
}
