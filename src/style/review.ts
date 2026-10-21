import { newId, ok, perr, type Clock, type Result } from '../core/index.ts';
import { withTransaction, type Db } from '../store/index.ts';
import { detectSensitive, scrubPii } from '../memory/sensitive.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { Fact } from '../memory/types.ts';
import type { Register } from './classify.ts';
import { draftInStyle, type DraftPrompt, type DraftRequest } from './draft.ts';
import { textHash } from './examples.ts';
import type { StyleStats } from './stats.ts';

/**
 * Owner review of sample drafts — the style-quality gate (plan Phase 2).
 * generateReviewSamples() builds N drafting prompts from fixed, harmless
 * scenarios; the owner runs them through the local model, reads the drafts
 * and rates each 1–5 (optionally supplying the wording they would actually
 * use). Ratings are stored as verified owner_feedback facts in memory;
 * supplied wording becomes an owner-approved style example derived from that
 * fact (forgetting the fact removes the example).
 */
export const FEEDBACK_SOURCE_ID = 'src_owner_feedback';

export interface Scenario {
  register: Register;
  request: DraftRequest;
}

export const REVIEW_SCENARIOS: readonly Scenario[] = [
  { register: 'casual', request: { register: 'casual', purpose: 'Tell a friend you are running about 10 minutes late.', recipientDescription: 'close friend', facts: ['Running about 10 minutes late'] } },
  { register: 'casual', request: { register: 'casual', purpose: 'Reply yes to a friend asking to hang out on Saturday afternoon.', recipientDescription: 'friend', facts: ['Free on Saturday afternoon'], replyTo: 'you free saturday?' } },
  { register: 'casual', request: { register: 'casual', purpose: 'Thank a friend for sending you the notes from class.', recipientDescription: 'classmate', facts: ['They sent the class notes'] } },
  { register: 'casual', request: { register: 'casual', purpose: 'Ask a friend if they got home okay.', recipientDescription: 'friend' } },
  { register: 'casual', request: { register: 'casual', purpose: 'Say you cannot make it tonight and suggest another day without naming one.', recipientDescription: 'friend', facts: ['Cannot make it tonight'] } },
  { register: 'professional', request: { register: 'professional', purpose: 'Confirm availability for an interview.', recipientDescription: 'recruiter', facts: ['Available Tuesday afternoon'], replyTo: 'Are you available for a 30 minute interview this week?' } },
  { register: 'professional', request: { register: 'professional', purpose: 'Ask a professor a clarifying question about the assignment due date.', recipientDescription: 'professor', facts: ['Unsure whether the due date is Friday or Sunday'] } },
  { register: 'professional', request: { register: 'professional', purpose: 'Follow up on a job application submitted last week.', recipientDescription: 'hiring manager', facts: ['Applied last week'] } },
  { register: 'professional', request: { register: 'professional', purpose: 'Thank a client for their feedback and say you will review it.', recipientDescription: 'client', facts: ['Received their feedback'] } },
  { register: 'professional', request: { register: 'professional', purpose: 'Politely decline a meeting time and ask for alternatives.', recipientDescription: 'colleague', facts: ['The proposed time does not work'] } },
];

export interface ReviewSample {
  id: string;
  register: Register;
  scenario: string;
  prompt: DraftPrompt;
}

export function generateReviewSamples(
  db: Db,
  clock: Clock,
  stats: Record<Register, StyleStats> | null,
  opts: { n?: number; register?: Register } = {},
): ReviewSample[] {
  const n = Math.min(Math.max(opts.n ?? 6, 1), REVIEW_SCENARIOS.length);
  let pool = REVIEW_SCENARIOS.filter((s) => !opts.register || s.register === opts.register);
  if (!opts.register) {
    // Alternate registers so a small n covers both.
    const c = pool.filter((s) => s.register === 'casual');
    const p = pool.filter((s) => s.register === 'professional');
    pool = [];
    for (let i = 0; i < Math.max(c.length, p.length); i++) {
      if (c[i]) pool.push(c[i]!);
      if (p[i]) pool.push(p[i]!);
    }
  }
  const out: ReviewSample[] = [];
  const ins = db.prepare('INSERT INTO style_review_samples (id, register, scenario, prompt_hash, example_ids_json, created_at) VALUES (?,?,?,?,?,?)');
  withTransaction(db, () => {
    for (const s of pool.slice(0, n)) {
      const prompt = draftInStyle(db, s.request, stats?.[s.register] ?? null);
      const id = newId('srv', clock);
      ins.run(id, s.register, s.request.purpose, prompt.promptHash, JSON.stringify(prompt.exampleIds), clock.nowIso());
      out.push({ id, register: s.register, scenario: s.request.purpose, prompt });
    }
  });
  return out;
}

export interface RatingInput {
  rating: number;
  comment?: string;
  /** The wording the owner would actually send; stored as an owner-approved example. */
  approvedText?: string;
}

export function rateSample(db: Db, memory: MemoryStore, clock: Clock, sampleId: string, input: RatingInput): Result<{ fact: Fact; exampleId: string | null }> {
  const row = db.prepare('SELECT * FROM style_review_samples WHERE id = ?').get(sampleId) as { id: string; register: Register; scenario: string; rating: number | null } | undefined;
  if (!row) return perr('not_found', `no review sample ${sampleId}`);
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) return perr('invalid_input', 'rating must be an integer 1–5');
  let approved: string | null = null;
  if (input.approvedText && input.approvedText.trim()) {
    const verdict = detectSensitive(input.approvedText);
    if (verdict.sensitive) return perr('invalid_input', `approved text looks sensitive (${verdict.reasons.join(', ')}); not stored`);
    approved = scrubPii(input.approvedText.trim()).text.slice(0, 1000);
  }
  const comment = input.comment ? scrubPii(input.comment.trim()).text.slice(0, 500) : '';
  const src = memory.registerSource({ id: FEEDBACK_SOURCE_ID, kind: 'owner_feedback', label: 'Owner ratings of style samples' });
  if (!src.ok) return src;
  const text = `Style feedback (${row.register}): owner rated the sample draft for "${row.scenario}" ${input.rating}/5.${comment ? ` Comment: ${comment}` : ''}${approved ? ` Preferred wording: ${JSON.stringify(approved)}` : ''}`;
  const fact = memory.remember({
    text,
    sourceId: FEEDBACK_SOURCE_ID,
    sourceRef: `style_review:${sampleId}`,
    status: 'verified',
    confidence: 1,
    topic: 'style_feedback',
    tags: ['style-feedback', row.register],
    actor: 'owner',
  });
  if (!fact.ok) return fact;
  let exampleId: string | null = null;
  withTransaction(db, () => {
    db.prepare('UPDATE style_review_samples SET rating = ?, rated_at = ?, fact_id = ? WHERE id = ?').run(input.rating, clock.nowIso(), fact.value.id, sampleId);
    if (approved) {
      const id = newId('sx', clock);
      const r = db
        .prepare(
          "INSERT OR IGNORE INTO style_examples (id, register, text, text_hash, corpus_id, fact_id, source_id, source_ref, origin, created_at) VALUES (?,?,?,?,NULL,?,?,?,'owner_approved',?)",
        )
        .run(id, row.register, approved, textHash(approved), fact.value.id, FEEDBACK_SOURCE_ID, `style_review:${sampleId}`, clock.nowIso());
      if (Number(r.changes) > 0) {
        db.prepare('INSERT INTO style_examples_fts (example_id, register, text) VALUES (?, ?, ?)').run(id, row.register, approved);
        exampleId = id;
      }
    }
  });
  return ok({ fact: fact.value, exampleId });
}

export interface FeedbackSummary {
  register: Register;
  rated: number;
  average: number | null;
  /** Gate: at least 5 rated samples averaging >= 4. */
  accepted: boolean;
}

export function feedbackSummary(db: Db): FeedbackSummary[] {
  return (['casual', 'professional'] as const).map((register) => {
    const r = db.prepare('SELECT COUNT(rating) AS n, AVG(rating) AS avg FROM style_review_samples WHERE register = ? AND rating IS NOT NULL').get(register) as { n: number; avg: number | null };
    const average = r.avg === null ? null : Math.round(r.avg * 100) / 100;
    return { register, rated: r.n, average, accepted: r.n >= 5 && (average ?? 0) >= 4 };
  });
}
