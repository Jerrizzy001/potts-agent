import type { Db } from '../store/index.ts';

/**
 * Deletion of style rows derived from memory sources/facts. Shared by the
 * memory store (forget / revoke / retention / restore) and the style module.
 * Callers run these inside a transaction and turn the returned rows into
 * tombstones. Returned values are ids and hashes only.
 */
export interface DeletedRow {
  id: string;
  hash: string | null;
  sourceId: string | null;
}

export interface DerivedDeletion {
  corpus: DeletedRow[];
  examples: DeletedRow[];
}

function deleteExamplesWhere(db: Db, where: string, params: (string | number)[]): DeletedRow[] {
  const rows = db
    .prepare(`SELECT id, text_hash AS hash, source_id AS sourceId FROM style_examples WHERE ${where}`)
    .all(...params) as unknown as DeletedRow[];
  const delFts = db.prepare('DELETE FROM style_examples_fts WHERE example_id = ?');
  const del = db.prepare('DELETE FROM style_examples WHERE id = ?');
  for (const r of rows) {
    delFts.run(r.id);
    del.run(r.id);
  }
  return rows;
}

function deleteCorpusWhere(db: Db, where: string, params: (string | number)[]): DerivedDeletion {
  const corpus = db
    .prepare(`SELECT id, text_hash AS hash, source_id AS sourceId FROM style_corpus WHERE ${where}`)
    .all(...params) as unknown as DeletedRow[];
  const examples: DeletedRow[] = [];
  const del = db.prepare('DELETE FROM style_corpus WHERE id = ?');
  for (const c of corpus) {
    examples.push(...deleteExamplesWhere(db, 'corpus_id = ?', [c.id]));
    del.run(c.id);
  }
  return { corpus, examples };
}

export function deleteDerivedByFact(db: Db, factId: string): DerivedDeletion {
  return { corpus: [], examples: deleteExamplesWhere(db, 'fact_id = ?', [factId]) };
}

export function deleteDerivedBySource(db: Db, sourceId: string): DerivedDeletion {
  const d = deleteCorpusWhere(db, 'source_id = ?', [sourceId]);
  d.examples.push(...deleteExamplesWhere(db, 'source_id = ?', [sourceId]));
  return d;
}

export function deleteDerivedBySourceRef(db: Db, sourceId: string, ref: string): DerivedDeletion {
  const d = deleteCorpusWhere(db, 'source_id = ? AND source_ref = ?', [sourceId, ref]);
  d.examples.push(...deleteExamplesWhere(db, 'source_id = ? AND source_ref = ?', [sourceId, ref]));
  return d;
}

/** Corpus rows of the given sources older than cutoff (by ingested_at or sent_at). */
export function deleteCorpusOlderThan(db: Db, sourceIds: string[], cutoffIso: string, basis: 'recorded' | 'observed'): DerivedDeletion {
  const out: DerivedDeletion = { corpus: [], examples: [] };
  const col = basis === 'observed' ? 'COALESCE(sent_at, ingested_at)' : 'ingested_at';
  for (const sid of sourceIds) {
    const d = deleteCorpusWhere(db, `source_id = ? AND ${col} < ?`, [sid, cutoffIso]);
    out.corpus.push(...d.corpus);
    out.examples.push(...d.examples);
  }
  return out;
}

export function deleteCorpusById(db: Db, id: string): DerivedDeletion {
  return deleteCorpusWhere(db, 'id = ?', [id]);
}

export function deleteExampleById(db: Db, id: string): DeletedRow[] {
  return deleteExamplesWhere(db, 'id = ?', [id]);
}

export function countDerivedForFact(db: Db, factId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM style_examples WHERE fact_id = ?').get(factId) as { n: number }).n;
}
