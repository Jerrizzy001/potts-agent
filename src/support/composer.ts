/**
 * Reply composition. The "verbatim" composer builds a reply ONLY from fixed
 * template lines plus the exact text of approved knowledge items, so an
 * automatic reply can never contain model-invented promises. Any other
 * composer (e.g. a local-model rewrite) is marked as such and its replies
 * always go to the owner.
 */
import type { KnowledgeBase, KnowledgeItem } from './knowledge.ts';
import type { Classification } from './classifier.ts';

export type ComposerKind = 'verbatim' | 'holding_template' | 'none';

export interface ComposedReply {
  composer: ComposerKind;
  subject: string | null;
  body: string | null;
  cited: KnowledgeItem[];
  /** Status items that are too old to rely on (automatic replies refuse them). */
  staleStatus: string[];
}

const STOP = new Set('a an the and or but if to of in on at for with my your our is are was were be been it this that i you we me us can do does how what when where why which who will would should could have has had not no yes please thanks thank hi hello hey from about'.split(' '));

export const tokenize = (s: string): Set<string> => new Set(s.toLowerCase().normalize('NFKC').replace(/[^a-z0-9'\s-]/g, ' ').split(/\s+/).map((w) => w.replace(/^'+|'+$/g, '')).filter((w) => w.length > 1 && !STOP.has(w)));

/** Keyword-overlap score: a matched multi-word keyword (all its words present) counts 2, a single word 1. */
export function scoreItem(item: KnowledgeItem, text: string, tokens: Set<string>): number {
  let score = 0;
  for (const k of item.keywords) {
    const kt = [...tokenize(k)];
    if (!kt.length) continue;
    // A phrase matches when all of its content words occur in the message.
    if (kt.every((t) => tokens.has(t))) score += kt.length > 1 ? 2 : 1;
  }
  for (const t of tokenize(item.title)) if (tokens.has(t)) score += 0.25;
  return score;
}

export function retrieve(kb: KnowledgeBase, app: string, text: string, opts: { minScore?: number; max?: number } = {}): KnowledgeItem[] {
  const tokens = tokenize(text);
  return kb
    .forApp(app)
    .map((item) => ({ item, s: scoreItem(item, text, tokens) }))
    .filter((x) => x.s >= (opts.minScore ?? 2))
    .sort((a, b) => b.s - a.s || (a.item.id < b.item.id ? -1 : 1))
    .slice(0, opts.max ?? 2)
    .map((x) => x.item);
}

export const replySubject = (s: string | undefined): string => {
  const base = (s ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!base) return 'Re: your support request';
  return /^re:/i.test(base) ? base.slice(0, 900) : `Re: ${base}`.slice(0, 900);
};

export function composeReply(input: {
  kb: KnowledgeBase;
  app: { id: string; name: string };
  classification: Classification;
  text: string;
  subject?: string;
  signature?: string;
  now: Date;
  maxStatusAgeHours: number;
}): ComposedReply {
  const subject = replySubject(input.subject);
  const sign = input.signature ?? `${input.app.name} Support`;
  if (input.classification.category !== 'customer_support') {
    // Owner-review placeholder: acknowledges receipt without any commitment.
    const body = ['Hi,', '', `Thanks for your message. It has been passed on and you will get a personal reply.`, '', sign].join('\n');
    return { composer: 'holding_template', subject, body, cited: [], staleStatus: [] };
  }
  const cited = retrieve(input.kb, input.app.id, `${input.subject ?? ''}\n${input.text}`);
  if (!cited.length) return { composer: 'none', subject, body: null, cited: [], staleStatus: [] };
  const staleStatus = cited
    .filter((c) => c.kind === 'status' && (!c.verifiedAt || input.now.getTime() - Date.parse(c.verifiedAt) > input.maxStatusAgeHours * 3600_000))
    .map((c) => c.id);
  const body = ['Hi,', '', `Thanks for contacting ${input.app.name} support.`, '', ...cited.flatMap((c) => [c.answer, '']), sign].join('\n');
  return { composer: 'verbatim', subject, body, cited, staleStatus };
}
