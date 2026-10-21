import { hashCanonical, newId, perr, ok, type Clock, type Result } from '../core/index.ts';
import { withTransaction, type Db } from '../store/index.ts';
import { openChatDb, type ExclusionReason, type OpenChatDbOptions } from '../connectors/imessage/reader.ts';
import { scrubPii } from '../memory/sensitive.ts';
import type { MemoryStore } from '../memory/store.ts';
import { classifyRegister, type Register } from './classify.ts';
import { DEFAULT_EXAMPLE_COUNTS, rebuildExamples, textHash } from './examples.ts';
import { writeStyleGuides } from './guide.ts';
import { computeStyleStats, type StyleStats } from './stats.ts';

export const IMESSAGE_SOURCE_ID = 'src_imessage_local';

export interface BuildStyleOptions {
  db: Db;
  memory: MemoryStore;
  clock: Clock;
  home: string;
  chatDbPath: string;
  mode?: OpenChatDbOptions['mode'];
  tempRoot?: string;
  /** Ignore the cursor and rescan everything (already-ingested rows are skipped). */
  full?: boolean;
  /** Read and classify only; write nothing (no corpus, cursor, guides). */
  dryRun?: boolean;
  batchSize?: number;
  maxRows?: number;
  personalEmailDomains?: string[];
  exampleCounts?: Partial<Record<Register, number>>;
}

export interface BuildStyleSummary {
  buildId: string | null;
  dryRun: boolean;
  readerMode: 'copy' | 'immutable';
  cursor: { from: number; to: number };
  scanned: number;
  kept: number;
  inserted: number;
  excluded: Partial<Record<ExclusionReason, number>>;
  byRegister: Record<Register, number>;
  corpus: Record<Register, number>;
  examples: Record<Register, number>;
  guidePaths: string[];
}

export function corpusTexts(db: Db, register: Register): string[] {
  return (db.prepare('SELECT text FROM style_corpus WHERE register = ?').all(register) as { text: string }[]).map((r) => r.text);
}

export function computeAllStats(db: Db): Record<Register, StyleStats> {
  return { casual: computeStyleStats('casual', corpusTexts(db, 'casual')), professional: computeStyleStats('professional', corpusTexts(db, 'professional')) };
}

/**
 * Incrementally ingests owner-authored messages from chat.db into the local
 * style corpus (filtered + scrubbed), then recomputes statistics, the example
 * set and the markdown guides. Returns counts only.
 */
export function buildStyle(o: BuildStyleOptions): Result<BuildStyleSummary> {
  const src = o.memory.registerSource({ id: IMESSAGE_SOURCE_ID, kind: 'imessage', label: 'Local Messages archive (owner-authored only)' });
  if (!src.ok) return src;
  if (src.value.revokedAt) return perr('revoked', 'the local iMessage source was revoked; un-revoking requires a new source id decision by the owner');
  const db = o.db;
  const cursorRow = db.prepare('SELECT last_rowid FROM style_cursors WHERE source_id = ?').get(IMESSAGE_SOURCE_ID) as { last_rowid: number } | undefined;
  const from = o.full ? 0 : (cursorRow?.last_rowid ?? 0);
  const openOpts: OpenChatDbOptions = { dbPath: o.chatDbPath };
  if (o.mode) openOpts.mode = o.mode;
  if (o.tempRoot) openOpts.tempRoot = o.tempRoot;
  if (o.personalEmailDomains) openOpts.personalEmailDomains = o.personalEmailDomains;
  const reader = openChatDb(openOpts);
  let batch;
  try {
    const ro: { batchSize?: number; maxRows?: number } = {};
    if (o.batchSize) ro.batchSize = o.batchSize;
    if (o.maxRows) ro.maxRows = o.maxRows;
    batch = reader.readAll(from, ro);
  } finally {
    reader.close();
  }
  const byRegister: Record<Register, number> = { casual: 0, professional: 0 };
  const prepared = batch.messages.map((m) => {
    const scrubbed = scrubPii(m.text).text;
    const verdict = classifyRegister(scrubbed, { chatKind: m.chatKind, recipientKind: m.recipientKind, participantCount: m.participantCount });
    byRegister[verdict.register]++;
    return { m, scrubbed, verdict };
  });
  const summary: BuildStyleSummary = {
    buildId: null,
    dryRun: !!o.dryRun,
    readerMode: reader.mode,
    cursor: { from, to: Math.max(from, batch.lastRowid) },
    scanned: batch.scanned,
    kept: batch.messages.length,
    inserted: 0,
    excluded: batch.excluded,
    byRegister,
    corpus: { casual: 0, professional: 0 },
    examples: { casual: 0, professional: 0 },
    guidePaths: [],
  };
  if (o.dryRun) return ok(summary);

  const now = o.clock.nowIso();
  withTransaction(db, () => {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO style_corpus (id, source_id, source_ref, register, register_score, chat_kind, recipient_kind, text, text_hash, sent_at, ingested_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const p of prepared) {
      const r = ins.run(
        newId('sc', o.clock),
        IMESSAGE_SOURCE_ID,
        `imessage:rowid:${p.m.rowid}`,
        p.verdict.register,
        p.verdict.score,
        p.m.chatKind,
        p.m.recipientKind,
        p.scrubbed,
        textHash(p.scrubbed),
        p.m.sentAt,
        now,
      );
      summary.inserted += Number(r.changes);
    }
    db.prepare(
      'INSERT INTO style_cursors (source_id, last_rowid, updated_at) VALUES (?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET last_rowid = MAX(last_rowid, excluded.last_rowid), updated_at = excluded.updated_at',
    ).run(IMESSAGE_SOURCE_ID, summary.cursor.to, now);
  });

  const stats = computeAllStats(db);
  const counts = { ...DEFAULT_EXAMPLE_COUNTS, ...(o.exampleCounts ?? {}) };
  summary.examples.casual = rebuildExamples(db, 'casual', counts.casual, o.clock);
  summary.examples.professional = rebuildExamples(db, 'professional', counts.professional, o.clock);
  summary.corpus = { casual: stats.casual.count, professional: stats.professional.count };
  summary.guidePaths = writeStyleGuides(o.home, stats, now);
  const buildId = newId('sb', o.clock);
  db.prepare('INSERT INTO style_builds (id, built_at, source_ids_json, counts_json, stats_hash, guide_paths_json) VALUES (?,?,?,?,?,?)').run(
    buildId,
    now,
    JSON.stringify([IMESSAGE_SOURCE_ID]),
    JSON.stringify({ scanned: summary.scanned, kept: summary.kept, inserted: summary.inserted, corpus: summary.corpus, examples: summary.examples, excluded: summary.excluded }),
    hashCanonical(stats),
    JSON.stringify(summary.guidePaths),
  );
  summary.buildId = buildId;
  return ok(summary);
}

/** Recomputes stats/examples/guides from the stored corpus without reading chat.db (e.g. after forget). */
export function rebuildFromCorpus(o: { db: Db; clock: Clock; home: string; exampleCounts?: Partial<Record<Register, number>> }): { stats: Record<Register, StyleStats>; guidePaths: string[] } {
  const stats = computeAllStats(o.db);
  const counts = { ...DEFAULT_EXAMPLE_COUNTS, ...(o.exampleCounts ?? {}) };
  rebuildExamples(o.db, 'casual', counts.casual, o.clock);
  rebuildExamples(o.db, 'professional', counts.professional, o.clock);
  return { stats, guidePaths: writeStyleGuides(o.home, stats, o.clock.nowIso()) };
}
