import { newId, sha256Hex, type Clock } from '../core/index.ts';
import { withTransaction, type Db } from '../store/index.ts';
import { ftsQuery } from '../memory/store.ts';
import { tokenize, type Register } from './classify.ts';

/**
 * Representative example set: a small, deduplicated, PII-scrubbed sample of
 * the owner's own messages per register, stratified by length so short and
 * long messages are both represented. Stored locally in style_examples with an
 * FTS index for retrieval when drafting.
 */
export interface StyleExample {
  id: string;
  register: Register;
  text: string;
  origin: 'corpus' | 'owner_approved';
  corpusId: string | null;
  factId: string | null;
}

export const DEFAULT_EXAMPLE_COUNTS: Record<Register, number> = { casual: 40, professional: 25 };

export function normalizeForHash(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function textHash(text: string): string {
  return sha256Hex(normalizeForHash(text));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

export interface CorpusRow {
  id: string;
  text: string;
  text_hash: string;
  source_id: string;
  source_ref: string;
}

/** Pure selection: dedupe (exact + near-duplicate), filter, stratify by length. */
export function selectExamples(rows: CorpusRow[], n: number): CorpusRow[] {
  const seen = new Set<string>();
  const candidates: { row: CorpusRow; words: number; toks: Set<string>; key: string }[] = [];
  for (const row of rows) {
    if (seen.has(row.text_hash)) continue;
    seen.add(row.text_hash);
    const toks = tokenize(row.text);
    if (toks.length < 3 || toks.length > 60) continue;
    const placeholders = (row.text.match(/\[(link|email|phone|handle|number)\]/g) ?? []).length;
    if (placeholders / toks.length > 0.2) continue;
    candidates.push({ row, words: toks.length, toks: new Set(toks), key: sha256Hex(row.id) });
  }
  if (candidates.length === 0 || n <= 0) return [];
  candidates.sort((a, b) => a.words - b.words || a.key.localeCompare(b.key));
  const buckets = 4;
  const per = Math.ceil(n / buckets);
  const picked: typeof candidates = [];
  for (let b = 0; b < buckets; b++) {
    const slice = candidates.slice(Math.floor((b * candidates.length) / buckets), Math.floor(((b + 1) * candidates.length) / buckets));
    slice.sort((x, y) => x.key.localeCompare(y.key)); // deterministic pseudo-random within a length band
    let taken = 0;
    for (const c of slice) {
      if (taken >= per || picked.length >= n) break;
      if (picked.some((p) => jaccard(p.toks, c.toks) >= 0.8)) continue;
      picked.push(c);
      taken++;
    }
  }
  return picked.map((p) => p.row);
}

/** Replaces the corpus-derived example set for a register (owner-approved examples are kept). */
export function rebuildExamples(db: Db, register: Register, n: number, clock: Clock): number {
  const rows = db.prepare('SELECT id, text, text_hash, source_id, source_ref FROM style_corpus WHERE register = ?').all(register) as unknown as CorpusRow[];
  const chosen = selectExamples(rows, n);
  return withTransaction(db, () => {
    const old = db.prepare("SELECT id FROM style_examples WHERE register = ? AND origin = 'corpus'").all(register) as { id: string }[];
    const delFts = db.prepare('DELETE FROM style_examples_fts WHERE example_id = ?');
    for (const o of old) delFts.run(o.id);
    db.prepare("DELETE FROM style_examples WHERE register = ? AND origin = 'corpus'").run(register);
    const ins = db.prepare(
      "INSERT OR IGNORE INTO style_examples (id, register, text, text_hash, corpus_id, fact_id, source_id, source_ref, origin, created_at) VALUES (?,?,?,?,?,NULL,?,?,'corpus',?)",
    );
    const insFts = db.prepare('INSERT INTO style_examples_fts (example_id, register, text) VALUES (?, ?, ?)');
    let count = 0;
    for (const c of chosen) {
      const id = newId('sx', clock);
      const r = ins.run(id, register, c.text, c.text_hash, c.id, c.source_id, c.source_ref, clock.nowIso());
      if (Number(r.changes) > 0) {
        insFts.run(id, register, c.text);
        count++;
      }
    }
    return count;
  });
}

interface ExampleRow {
  id: string;
  register: Register;
  text: string;
  origin: 'corpus' | 'owner_approved';
  corpus_id: string | null;
  fact_id: string | null;
}
const toExample = (r: ExampleRow): StyleExample => ({ id: r.id, register: r.register, text: r.text, origin: r.origin, corpusId: r.corpus_id, factId: r.fact_id });

export function listExamples(db: Db, register?: Register): StyleExample[] {
  const rows = register
    ? db.prepare('SELECT * FROM style_examples WHERE register = ? ORDER BY origin DESC, id').all(register)
    : db.prepare('SELECT * FROM style_examples ORDER BY register, origin DESC, id').all();
  return (rows as unknown as ExampleRow[]).map(toExample);
}

/**
 * Retrieves k (3–5) examples for a drafting request: owner-approved first,
 * then FTS matches on the request text, then representative fill.
 */
export function retrieveExamples(db: Db, register: Register, query: string, k = 4): StyleExample[] {
  const want = Math.min(Math.max(k, 3), 5);
  const out: StyleExample[] = [];
  const have = new Set<string>();
  const push = (rows: ExampleRow[]) => {
    for (const r of rows) {
      if (out.length >= want) return;
      if (have.has(r.id)) continue;
      have.add(r.id);
      out.push(toExample(r));
    }
  };
  push(db.prepare("SELECT * FROM style_examples WHERE register = ? AND origin = 'owner_approved' ORDER BY created_at DESC LIMIT 2").all(register) as unknown as ExampleRow[]);
  for (const mode of ['and', 'or'] as const) {
    if (out.length >= want) break;
    const fq = ftsQuery(query, mode);
    if (!fq) break;
    push(
      db
        .prepare(
          `SELECT e.* FROM style_examples_fts f JOIN style_examples e ON e.id = f.example_id
           WHERE style_examples_fts MATCH ? AND f.register = ? ORDER BY bm25(style_examples_fts) LIMIT 10`,
        )
        .all(fq, register) as unknown as ExampleRow[],
    );
  }
  if (out.length < want) {
    const rest = db.prepare('SELECT * FROM style_examples WHERE register = ?').all(register) as unknown as ExampleRow[];
    rest.sort((a, b) => sha256Hex(query + a.id).localeCompare(sha256Hex(query + b.id)));
    push(rest);
  }
  return out;
}
