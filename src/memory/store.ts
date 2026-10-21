import { appendFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashCanonical, newId, nullLogger, ok, perr, PottsError, type Clock, type Logger, type Result } from '../core/index.ts';
import { withTransaction, type Db } from '../store/index.ts';
import {
  countDerivedForFact,
  deleteCorpusById,
  deleteCorpusOlderThan,
  deleteDerivedByFact,
  deleteDerivedBySource,
  deleteDerivedBySourceRef,
  deleteExampleById,
  type DerivedDeletion,
} from './derived.ts';
import { blobToVector, cosine, disabledEmbeddings, vectorToBlob, type EmbeddingProvider } from './embeddings.ts';
import {
  FACT_STATUSES,
  MEMORY_ACTORS,
  SOURCE_KIND_RE,
  type CorrectInput,
  type DeletionCounts,
  type DeletionReceipt,
  type Fact,
  type FactInspection,
  type FactStatus,
  type FactVersion,
  type MemoryActor,
  type MemorySource,
  type RememberInput,
  type RetentionRule,
  type SearchHit,
  type SearchOptions,
  type Tombstone,
  type TombstoneEntity,
} from './types.ts';

export const OWNER_SOURCE_ID = 'src_owner';
export const MAX_FACT_CHARS = 4000;
const STATUS_WEIGHT: Record<FactStatus, number> = { verified: 1, draft: 0.6, inferred: 0.5 };

export interface MemoryStoreOptions {
  db: Db;
  clock: Clock;
  retention?: Record<string, RetentionRule>;
  /** Absolute path of the content-free tombstone journal (JSON lines). Omit to disable. */
  tombstoneJournalPath?: string;
  embeddings?: EmbeddingProvider;
  logger?: Logger;
  /** Run FTS 'optimize' + WAL checkpoint after deletions so removed text does not linger in index segments/WAL. Default true. */
  compactAfterDelete?: boolean;
}

export interface MemoryStore {
  registerSource(input: { id?: string; kind: string; label?: string }): Result<MemorySource>;
  getSource(id: string): MemorySource | undefined;
  listSources(): MemorySource[];
  remember(input: RememberInput): Result<Fact>;
  get(id: string): Fact | undefined;
  search(query: string, opts?: SearchOptions): SearchHit[];
  semanticSearch(query: string, opts?: SearchOptions): Promise<SearchHit[]>;
  embedPending(limit?: number): Promise<number>;
  inspect(id: string): Result<FactInspection>;
  correct(id: string, input: CorrectInput): Result<Fact>;
  previewForget(id: string): Result<DeletionCounts>;
  forget(id: string): Result<DeletionReceipt>;
  forgetSourceRef(sourceId: string, ref: string): Result<DeletionReceipt>;
  forgetStyleCorpus(corpusId: string): Result<DeletionReceipt>;
  forgetStyleExample(exampleId: string): Result<DeletionReceipt>;
  previewRevokeSource(sourceId: string): Result<DeletionCounts>;
  revokeSource(sourceId: string): Result<DeletionReceipt>;
  purgeExpired(clock?: Clock): DeletionReceipt[];
  listTombstones(opts?: { afterSeq?: number; limit?: number }): Tombstone[];
  reapplyTombstones(tombstones: readonly Omit<Tombstone, 'seq'>[]): DeletionReceipt;
  receipts(limit?: number): DeletionReceipt[];
  readonly db: Db;
  readonly clock: Clock;
}

interface VersionRow {
  fact_id: string;
  version: number;
  text: string;
  tags_json: string;
  status: FactStatus;
  confidence: number;
  source_id: string;
  source_kind: string;
  source_ref: string | null;
  observed_at: string | null;
  recorded_at: string;
  actor: MemoryActor;
  correction_reason: string | null;
  content_hash: string;
  superseded_at: string | null;
}
interface FactRow {
  id: string;
  current_version: number;
  topic: string | null;
  created_at: string;
  updated_at: string;
}
interface SourceRow {
  id: string;
  kind: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
}

const toVersion = (r: VersionRow): FactVersion => ({
  factId: r.fact_id,
  version: r.version,
  text: r.text,
  tags: JSON.parse(r.tags_json) as string[],
  status: r.status,
  confidence: r.confidence,
  sourceId: r.source_id,
  sourceKind: r.source_kind,
  sourceRef: r.source_ref,
  observedAt: r.observed_at,
  recordedAt: r.recorded_at,
  actor: r.actor,
  correctionReason: r.correction_reason,
  contentHash: r.content_hash,
  supersededAt: r.superseded_at,
});
const toSource = (r: SourceRow): MemorySource => ({ id: r.id, kind: r.kind, label: r.label, createdAt: r.created_at, revokedAt: r.revoked_at });

const emptyCounts = (): DeletionCounts => ({ facts: 0, factVersions: 0, ftsRows: 0, embeddings: 0, styleCorpus: 0, styleExamples: 0, sourcesRevoked: 0 });

/** Turns free text into a safe FTS5 query: quoted tokens, prefix match on the last one. */
export function ftsQuery(query: string, mode: 'and' | 'or'): string | null {
  const toks = (query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 24);
  if (toks.length === 0) return null;
  const parts = toks.map((t, i) => `"${t.replace(/"/g, '')}"${i === toks.length - 1 && t.length >= 3 ? '*' : ''}`);
  return parts.join(mode === 'and' ? ' AND ' : ' OR ');
}

function validTags(tags: unknown): tags is string[] {
  return Array.isArray(tags) && tags.length <= 20 && tags.every((t) => typeof t === 'string' && /^[\p{L}\p{N}_:.-]{1,40}$/u.test(t));
}

function isIsoInstant(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s) && !Number.isNaN(Date.parse(s));
}

export function createMemoryStore(o: MemoryStoreOptions): MemoryStore {
  const { db } = o;
  const clock = o.clock;
  const log = o.logger ?? nullLogger;
  const embeddings = o.embeddings ?? disabledEmbeddings;
  const compact = o.compactAfterDelete ?? true;
  // Overwrite deleted content in the database file (forget must not leave text in free pages).
  db.exec('PRAGMA secure_delete = ON;');

  const q = {
    source: db.prepare('SELECT * FROM memory_sources WHERE id = ?'),
    fact: db.prepare('SELECT * FROM memory_facts WHERE id = ?'),
    version: db.prepare('SELECT * FROM memory_fact_versions WHERE fact_id = ? AND version = ?'),
    versions: db.prepare('SELECT * FROM memory_fact_versions WHERE fact_id = ? ORDER BY version'),
    insFact: db.prepare('INSERT INTO memory_facts (id, current_version, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
    insVersion: db.prepare(`INSERT INTO memory_fact_versions (fact_id, version, text, tags_json, status, confidence, source_id, source_kind,
      source_ref, observed_at, recorded_at, actor, correction_reason, content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    insFts: db.prepare('INSERT INTO memory_fts (fact_id, text, tags) VALUES (?, ?, ?)'),
    delFts: db.prepare('DELETE FROM memory_fts WHERE fact_id = ?'),
    insTomb: db.prepare('INSERT INTO memory_tombstones (entity, entity_id, content_hash, source_id, reason, receipt_id, deleted_at) VALUES (?,?,?,?,?,?,?)'),
  };

  function getSource(id: string): MemorySource | undefined {
    const r = q.source.get(id) as SourceRow | undefined;
    return r ? toSource(r) : undefined;
  }

  function ensureOwnerSource(): void {
    if (!getSource(OWNER_SOURCE_ID)) {
      db.prepare('INSERT OR IGNORE INTO memory_sources (id, kind, label, created_at) VALUES (?, ?, ?, ?)').run(OWNER_SOURCE_ID, 'owner_stated', 'Owner (direct)', clock.nowIso());
    }
  }

  function loadFact(id: string): Fact | undefined {
    const f = q.fact.get(id) as FactRow | undefined;
    if (!f) return undefined;
    const v = q.version.get(id, f.current_version) as VersionRow | undefined;
    if (!v) throw new PottsError('internal', `fact ${id} has no current version`);
    return { id: f.id, topic: f.topic, currentVersion: f.current_version, createdAt: f.created_at, updatedAt: f.updated_at, current: toVersion(v) };
  }

  function validateContent(text: string, status: FactStatus, confidence: number, actor: MemoryActor, tags: string[]): Result<void> {
    if (typeof text !== 'string' || !text.trim()) return perr('invalid_input', 'fact text is required');
    if (text.length > MAX_FACT_CHARS) return perr('invalid_input', `fact text longer than ${MAX_FACT_CHARS} chars; store a summary and a source reference instead`);
    if (!FACT_STATUSES.includes(status)) return perr('invalid_input', `status must be one of ${FACT_STATUSES.join(', ')}`);
    if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) return perr('invalid_input', 'confidence must be between 0 and 1');
    if (!MEMORY_ACTORS.includes(actor)) return perr('invalid_input', 'unknown actor');
    if (actor === 'model' && status === 'verified') return perr('denied', 'model-originated facts cannot be stored as verified; use draft or inferred');
    if (!validTags(tags)) return perr('invalid_input', 'tags must be up to 20 short slugs');
    return ok(undefined);
  }

  function usableSource(sourceId: string): Result<MemorySource> {
    const src = getSource(sourceId);
    if (!src) return perr('not_found', `unknown source ${sourceId}; register it first`);
    if (src.revokedAt) return perr('revoked', `source ${sourceId} was revoked; nothing more may be stored from it`);
    return ok(src);
  }

  // ---------- deletion core ----------

  interface Pending {
    entity: TombstoneEntity;
    entityId: string;
    hash: string | null;
    sourceId: string | null;
  }

  function deleteFactRows(factId: string, counts: DeletionCounts, pend: Pending[]): void {
    const versions = q.versions.all(factId) as unknown as VersionRow[];
    if (versions.length === 0) return;
    counts.embeddings += Number(db.prepare('DELETE FROM memory_embeddings WHERE fact_id = ?').run(factId).changes);
    counts.ftsRows += Number(q.delFts.run(factId).changes);
    for (const v of versions) pend.push({ entity: 'fact_version', entityId: `${factId}#${v.version}`, hash: v.content_hash, sourceId: v.source_id });
    counts.factVersions += versions.length;
    addDerived(deleteDerivedByFact(db, factId), counts, pend);
    db.prepare('DELETE FROM memory_fact_versions WHERE fact_id = ?').run(factId);
    db.prepare('DELETE FROM memory_facts WHERE id = ?').run(factId);
    pend.push({ entity: 'fact', entityId: factId, hash: hashCanonical(versions.map((v) => v.content_hash)), sourceId: versions[0]!.source_id });
    counts.facts += 1;
  }

  function addDerived(d: DerivedDeletion, counts: DeletionCounts, pend: Pending[]): void {
    for (const c of d.corpus) pend.push({ entity: 'style_corpus', entityId: c.id, hash: c.hash, sourceId: c.sourceId });
    for (const e of d.examples) pend.push({ entity: 'style_example', entityId: e.id, hash: e.hash, sourceId: e.sourceId });
    counts.styleCorpus += d.corpus.length;
    counts.styleExamples += d.examples.length;
  }

  /** Runs fn in a transaction, writes tombstones + receipt, then compacts and journals. */
  function runDeletion(reason: DeletionReceipt['reason'], target: string, fn: (counts: DeletionCounts, pend: Pending[]) => void): DeletionReceipt {
    const id = newId('del', clock);
    const at = clock.nowIso();
    const counts = emptyCounts();
    const pend: Pending[] = [];
    const tombs: Tombstone[] = [];
    const receipt = withTransaction(db, () => {
      fn(counts, pend);
      for (const p of pend) {
        const r = q.insTomb.run(p.entity, p.entityId, p.hash, p.sourceId, reason, id, at);
        tombs.push({ seq: Number(r.lastInsertRowid), entity: p.entity, entityId: p.entityId, contentHash: p.hash, sourceId: p.sourceId, reason, receiptId: id, deletedAt: at });
      }
      const body = {
        id,
        reason,
        target,
        at,
        counts,
        tombstones: { firstSeq: tombs[0]?.seq ?? null, lastSeq: tombs[tombs.length - 1]?.seq ?? null, count: tombs.length },
      };
      const receiptHash = hashCanonical(body);
      db.prepare('INSERT INTO memory_deletion_receipts (id, reason, target, counts_json, at, receipt_hash) VALUES (?,?,?,?,?,?)').run(
        id,
        reason,
        target,
        JSON.stringify(body.counts),
        at,
        receiptHash,
      );
      return { ...body, receiptHash, journalWritten: false };
    });
    if (compact && pend.length > 0) {
      try {
        db.exec("INSERT INTO memory_fts(memory_fts) VALUES('optimize')");
        db.exec("INSERT INTO style_examples_fts(style_examples_fts) VALUES('optimize')");
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (e) {
        log.warn('memory compaction after delete failed', { error: (e as Error).message });
      }
    }
    if (o.tombstoneJournalPath && tombs.length > 0) {
      try {
        const dir = dirname(o.tombstoneJournalPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
        appendFileSync(o.tombstoneJournalPath, tombs.map((t) => JSON.stringify(t)).join('\n') + '\n', { mode: 0o600 });
        chmodSync(o.tombstoneJournalPath, 0o600);
        receipt.journalWritten = true;
      } catch (e) {
        log.error('tombstone journal append failed', { error: (e as Error).message, receiptId: id });
      }
    }
    log.info('memory deletion', { receiptId: id, reason, counts });
    return receipt;
  }

  function factIdsFromSource(sourceId: string): string[] {
    return (db.prepare('SELECT DISTINCT fact_id FROM memory_fact_versions WHERE source_id = ?').all(sourceId) as { fact_id: string }[]).map((r) => r.fact_id);
  }

  function sourceDeletionCounts(sourceId: string): DeletionCounts {
    const c = emptyCounts();
    const ids = factIdsFromSource(sourceId);
    c.facts = ids.length;
    for (const fid of ids) {
      c.factVersions += (db.prepare('SELECT COUNT(*) AS n FROM memory_fact_versions WHERE fact_id = ?').get(fid) as { n: number }).n;
      c.styleExamples += countDerivedForFact(db, fid);
    }
    c.styleCorpus = (db.prepare('SELECT COUNT(*) AS n FROM style_corpus WHERE source_id = ?').get(sourceId) as { n: number }).n;
    c.styleExamples += (db.prepare('SELECT COUNT(*) AS n FROM style_examples WHERE source_id = ?').get(sourceId) as { n: number }).n;
    c.sourcesRevoked = 1;
    return c;
  }

  function rowsToHits(rows: { fact_id: string; rank: number; snip: string }[], limit: number): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const r of rows) {
      const fact = loadFact(r.fact_id);
      if (!fact) continue;
      const base = -r.rank; // bm25: lower is better
      const score = Math.max(base, 1e-9) * STATUS_WEIGHT[fact.current.status] * (0.5 + 0.5 * fact.current.confidence);
      hits.push({ fact, score, snippet: r.snip });
    }
    hits.sort((a, b) => b.score - a.score || a.fact.id.localeCompare(b.fact.id));
    return hits.slice(0, limit);
  }

  function filterSql(opts: SearchOptions, params: (string | number)[]): string {
    const where: string[] = ['v.superseded_at IS NULL'];
    if (opts.statuses?.length) {
      where.push(`v.status IN (${opts.statuses.map(() => '?').join(',')})`);
      params.push(...opts.statuses);
    }
    if (opts.sourceKinds?.length) {
      where.push(`v.source_kind IN (${opts.sourceKinds.map(() => '?').join(',')})`);
      params.push(...opts.sourceKinds);
    }
    if (opts.sourceIds?.length) {
      where.push(`v.source_id IN (${opts.sourceIds.map(() => '?').join(',')})`);
      params.push(...opts.sourceIds);
    }
    if (opts.topic) {
      where.push('f.topic = ?');
      params.push(opts.topic);
    }
    return where.join(' AND ');
  }

  function search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
    for (const mode of ['and', 'or'] as const) {
      const fq = ftsQuery(query, mode);
      if (!fq) return [];
      const params: (string | number)[] = [fq];
      const where = filterSql(opts, params);
      params.push(Math.min(limit * 5, 500));
      const rows = db
        .prepare(
          `SELECT m.fact_id AS fact_id, bm25(memory_fts, 0, 1.0, 0.5) AS rank, snippet(memory_fts, 1, '[', ']', '…', 12) AS snip
           FROM memory_fts m JOIN memory_facts f ON f.id = m.fact_id
           JOIN memory_fact_versions v ON v.fact_id = f.id AND v.version = f.current_version
           WHERE memory_fts MATCH ? AND ${where} ORDER BY rank LIMIT ?`,
        )
        .all(...params) as { fact_id: string; rank: number; snip: string }[];
      if (rows.length > 0 || mode === 'or') return rowsToHits(rows, limit);
    }
    return [];
  }

  const store: MemoryStore = {
    db,
    clock,

    registerSource({ id, kind, label }) {
      if (!SOURCE_KIND_RE.test(kind)) return perr('invalid_input', 'source kind must be a lowercase slug');
      const sid = id ?? newId('src', clock);
      if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(sid)) return perr('invalid_input', 'invalid source id');
      const existing = getSource(sid);
      if (existing) {
        if (existing.kind !== kind) return perr('invalid_input', `source ${sid} already registered with kind ${existing.kind}`);
        return ok(existing);
      }
      db.prepare('INSERT INTO memory_sources (id, kind, label, created_at) VALUES (?, ?, ?, ?)').run(sid, kind, label ?? null, clock.nowIso());
      return ok(getSource(sid)!);
    },

    getSource,

    listSources() {
      return (db.prepare('SELECT * FROM memory_sources ORDER BY created_at, id').all() as unknown as SourceRow[]).map(toSource);
    },

    remember(input) {
      const actor = input.actor ?? 'system';
      const tags = input.tags ?? [];
      const v = validateContent(input.text, input.status, input.confidence, actor, tags);
      if (!v.ok) return v;
      if (input.observedAt !== undefined && !isIsoInstant(input.observedAt)) return perr('invalid_input', 'observedAt must be a UTC ISO instant');
      if (input.sourceId === OWNER_SOURCE_ID) ensureOwnerSource();
      const src = usableSource(input.sourceId);
      if (!src.ok) return src;
      if (src.value.kind === 'potts_inference' && input.status !== 'inferred') return perr('invalid_input', 'facts from potts_inference sources must have status inferred');
      const id = newId('fact', clock);
      const now = clock.nowIso();
      const text = input.text.trim();
      const contentHash = hashCanonical({ text, tags, status: input.status, confidence: input.confidence, sourceId: input.sourceId, sourceRef: input.sourceRef ?? null });
      withTransaction(db, () => {
        q.insFact.run(id, 1, input.topic ?? null, now, now);
        q.insVersion.run(id, 1, text, JSON.stringify(tags), input.status, input.confidence, input.sourceId, src.value.kind, input.sourceRef ?? null, input.observedAt ?? null, now, actor, null, contentHash);
        q.insFts.run(id, text, tags.join(' '));
      });
      return ok(loadFact(id)!);
    },

    get: loadFact,

    search,

    async semanticSearch(query, opts = {}) {
      if (!embeddings.enabled) return search(query, opts);
      const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
      const [qv] = await embeddings.embed([query]);
      if (!qv) return search(query, opts);
      const params: (string | number)[] = [embeddings.model];
      const where = filterSql(opts, params);
      const rows = db
        .prepare(
          `SELECT e.fact_id AS fact_id, e.vector AS vector FROM memory_embeddings e
           JOIN memory_facts f ON f.id = e.fact_id AND e.version = f.current_version
           JOIN memory_fact_versions v ON v.fact_id = f.id AND v.version = f.current_version
           WHERE e.model = ? AND ${where}`,
        )
        .all(...params) as { fact_id: string; vector: Uint8Array }[];
      const sem = new Map<string, number>();
      for (const r of rows) sem.set(r.fact_id, cosine(qv, blobToVector(r.vector)));
      const lexical = search(query, { ...opts, limit: limit * 3 });
      const maxLex = Math.max(1e-9, ...lexical.map((h) => h.score));
      const merged = new Map<string, SearchHit>();
      for (const h of lexical) merged.set(h.fact.id, { ...h, score: 0.5 * (h.score / maxLex) + 0.5 * Math.max(0, sem.get(h.fact.id) ?? 0) });
      for (const [fid, s] of [...sem.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit * 3)) {
        if (merged.has(fid)) continue;
        const fact = loadFact(fid);
        if (!fact) continue;
        merged.set(fid, { fact, score: 0.5 * Math.max(0, s) * STATUS_WEIGHT[fact.current.status], snippet: fact.current.text.slice(0, 160) });
      }
      return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    },

    async embedPending(limit = 256) {
      if (!embeddings.enabled) return 0;
      const rows = db
        .prepare(
          `SELECT v.fact_id AS fact_id, v.version AS version, v.text AS text FROM memory_facts f
           JOIN memory_fact_versions v ON v.fact_id = f.id AND v.version = f.current_version
           LEFT JOIN memory_embeddings e ON e.fact_id = v.fact_id AND e.version = v.version AND e.model = ?
           WHERE e.fact_id IS NULL LIMIT ?`,
        )
        .all(embeddings.model, limit) as { fact_id: string; version: number; text: string }[];
      if (rows.length === 0) return 0;
      const vecs = await embeddings.embed(rows.map((r) => r.text));
      const ins = db.prepare('INSERT OR REPLACE INTO memory_embeddings (fact_id, version, model, dim, vector, created_at) VALUES (?,?,?,?,?,?)');
      let n = 0;
      withTransaction(db, () => {
        rows.forEach((r, i) => {
          const v = vecs[i];
          // The fact may have been forgotten/corrected while we awaited the local server.
          const still = db.prepare('SELECT 1 FROM memory_facts WHERE id = ? AND current_version = ?').get(r.fact_id, r.version);
          if (!v || !still) return;
          ins.run(r.fact_id, r.version, embeddings.model, v.length, vectorToBlob(v), clock.nowIso());
          n++;
        });
      });
      return n;
    },

    inspect(id) {
      const fact = loadFact(id);
      if (!fact) return perr('not_found', `no fact ${id}`);
      const versions = (q.versions.all(id) as unknown as VersionRow[]).map(toVersion);
      const sourceIds = [...new Set(versions.map((v) => v.sourceId))];
      const sources = sourceIds.map((s) => getSource(s)).filter((s): s is MemorySource => s !== undefined);
      const emb = (db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings WHERE fact_id = ?').get(id) as { n: number }).n;
      return ok({ ...fact, versions, sources, derived: { styleExamples: countDerivedForFact(db, id), embeddings: emb } });
    },

    correct(id, input) {
      const fact = loadFact(id);
      if (!fact) return perr('not_found', `no fact ${id}`);
      if (typeof input.reason !== 'string' || !input.reason.trim()) return perr('invalid_input', 'a correction reason is required');
      const actor = input.actor ?? 'owner';
      const sourceId = input.sourceId ?? OWNER_SOURCE_ID;
      if (sourceId === OWNER_SOURCE_ID) ensureOwnerSource();
      const src = usableSource(sourceId);
      if (!src.ok) return src;
      const cur = fact.current;
      const text = (input.text ?? cur.text).trim();
      const ownerish = actor === 'owner';
      const status = input.status ?? (ownerish ? 'verified' : cur.status);
      const confidence = input.confidence ?? (ownerish ? 1 : cur.confidence);
      const tags = input.tags ?? cur.tags;
      const v = validateContent(text, status, confidence, actor, tags);
      if (!v.ok) return v;
      if (text === cur.text && status === cur.status && confidence === cur.confidence && JSON.stringify(tags) === JSON.stringify(cur.tags)) {
        return perr('invalid_input', 'correction does not change anything');
      }
      const now = clock.nowIso();
      const next = fact.currentVersion + 1;
      const contentHash = hashCanonical({ text, tags, status, confidence, sourceId, sourceRef: input.sourceRef ?? null });
      withTransaction(db, () => {
        db.prepare('UPDATE memory_fact_versions SET superseded_at = ? WHERE fact_id = ? AND version = ?').run(now, id, fact.currentVersion);
        q.insVersion.run(id, next, text, JSON.stringify(tags), status, confidence, sourceId, src.value.kind, input.sourceRef ?? null, null, now, actor, input.reason.trim(), contentHash);
        db.prepare('UPDATE memory_facts SET current_version = ?, updated_at = ? WHERE id = ?').run(next, now, id);
        q.delFts.run(id);
        q.insFts.run(id, text, tags.join(' '));
      });
      return ok(loadFact(id)!);
    },

    previewForget(id) {
      if (!q.fact.get(id)) return perr('not_found', `no fact ${id}`);
      const c = emptyCounts();
      c.facts = 1;
      c.factVersions = (q.versions.all(id) as unknown[]).length;
      c.ftsRows = 1;
      c.embeddings = (db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings WHERE fact_id = ?').get(id) as { n: number }).n;
      c.styleExamples = countDerivedForFact(db, id);
      return ok(c);
    },

    forget(id) {
      if (!q.fact.get(id)) return perr('not_found', `no fact ${id}`);
      return ok(runDeletion('forget', id, (counts, pend) => deleteFactRows(id, counts, pend)));
    },

    forgetSourceRef(sourceId, ref) {
      if (!getSource(sourceId)) return perr('not_found', `unknown source ${sourceId}`);
      if (!ref) return perr('invalid_input', 'source ref is required');
      return ok(
        runDeletion('forget_source_ref', `${sourceId}:${hashCanonical(ref).slice(0, 16)}`, (counts, pend) => {
          const ids = (db.prepare('SELECT DISTINCT fact_id FROM memory_fact_versions WHERE source_id = ? AND source_ref = ?').all(sourceId, ref) as { fact_id: string }[]).map((r) => r.fact_id);
          for (const fid of ids) deleteFactRows(fid, counts, pend);
          addDerived(deleteDerivedBySourceRef(db, sourceId, ref), counts, pend);
        }),
      );
    },

    forgetStyleCorpus(corpusId) {
      if (!db.prepare('SELECT 1 FROM style_corpus WHERE id = ?').get(corpusId)) return perr('not_found', `no corpus row ${corpusId}`);
      return ok(runDeletion('forget', corpusId, (counts, pend) => addDerived(deleteCorpusById(db, corpusId), counts, pend)));
    },

    forgetStyleExample(exampleId) {
      if (!db.prepare('SELECT 1 FROM style_examples WHERE id = ?').get(exampleId)) return perr('not_found', `no style example ${exampleId}`);
      return ok(runDeletion('forget', exampleId, (counts, pend) => addDerived({ corpus: [], examples: deleteExampleById(db, exampleId) }, counts, pend)));
    },

    previewRevokeSource(sourceId) {
      if (!getSource(sourceId)) return perr('not_found', `unknown source ${sourceId}`);
      return ok(sourceDeletionCounts(sourceId));
    },

    revokeSource(sourceId) {
      const src = getSource(sourceId);
      if (!src) return perr('not_found', `unknown source ${sourceId}`);
      if (sourceId === OWNER_SOURCE_ID) return perr('invalid_input', 'the owner source cannot be revoked; forget individual facts instead');
      return ok(
        runDeletion('revoke_source', sourceId, (counts, pend) => {
          for (const fid of factIdsFromSource(sourceId)) deleteFactRows(fid, counts, pend);
          addDerived(deleteDerivedBySource(db, sourceId), counts, pend);
          db.prepare('DELETE FROM style_cursors WHERE source_id = ?').run(sourceId);
          db.prepare("UPDATE style_builds SET stale_at = ? WHERE stale_at IS NULL AND source_ids_json LIKE ?").run(clock.nowIso(), `%"${sourceId}"%`);
          if (!src.revokedAt) {
            db.prepare('UPDATE memory_sources SET revoked_at = ? WHERE id = ?').run(clock.nowIso(), sourceId);
            counts.sourcesRevoked = 1;
          }
          pend.push({ entity: 'source', entityId: sourceId, hash: null, sourceId });
        }),
      );
    },

    purgeExpired(c = clock) {
      const receipts: DeletionReceipt[] = [];
      const rules = o.retention ?? {};
      for (const [kind, rule] of Object.entries(rules).sort(([a], [b]) => a.localeCompare(b))) {
        if (rule.days === null || rule.days === undefined) continue;
        const cutoff = new Date(c.nowMs() - rule.days * 86_400_000).toISOString();
        const basis = rule.basis ?? 'recorded';
        const col = basis === 'observed' ? 'COALESCE(v.observed_at, v.recorded_at)' : 'v.recorded_at';
        const expired = db
          .prepare(
            `SELECT v.fact_id AS fact_id, v.version AS version, f.current_version AS current FROM memory_fact_versions v
             JOIN memory_facts f ON f.id = v.fact_id WHERE v.source_kind = ? AND ${col} < ?`,
          )
          .all(kind, cutoff) as { fact_id: string; version: number; current: number }[];
        const sourceIds = (db.prepare('SELECT id FROM memory_sources WHERE kind = ?').all(kind) as { id: string }[]).map((r) => r.id);
        const corpusCol = basis === 'observed' ? 'COALESCE(sent_at, ingested_at)' : 'ingested_at';
        const corpusN = sourceIds.length
          ? (db.prepare(`SELECT COUNT(*) AS n FROM style_corpus WHERE source_id IN (${sourceIds.map(() => '?').join(',')}) AND ${corpusCol} < ?`).get(...sourceIds, cutoff) as { n: number }).n
          : 0;
        if (expired.length === 0 && corpusN === 0) continue;
        receipts.push(
          runDeletion('retention', `retention:${kind}`, (counts, pend) => {
            const wholeFacts = new Set(expired.filter((e) => e.version === e.current).map((e) => e.fact_id));
            for (const fid of wholeFacts) deleteFactRows(fid, counts, pend);
            for (const e of expired) {
              if (wholeFacts.has(e.fact_id)) continue;
              const row = q.version.get(e.fact_id, e.version) as VersionRow | undefined;
              if (!row) continue;
              db.prepare('DELETE FROM memory_fact_versions WHERE fact_id = ? AND version = ?').run(e.fact_id, e.version);
              pend.push({ entity: 'fact_version', entityId: `${e.fact_id}#${e.version}`, hash: row.content_hash, sourceId: row.source_id });
              counts.factVersions += 1;
            }
            addDerived(deleteCorpusOlderThan(db, sourceIds, cutoff, basis), counts, pend);
          }),
        );
      }
      return receipts;
    },

    listTombstones({ afterSeq = 0, limit = 1000 } = {}) {
      return (
        db.prepare('SELECT * FROM memory_tombstones WHERE seq > ? ORDER BY seq LIMIT ?').all(afterSeq, Math.min(limit, 100_000)) as {
          seq: number;
          entity: TombstoneEntity;
          entity_id: string;
          content_hash: string | null;
          source_id: string | null;
          reason: string;
          receipt_id: string;
          deleted_at: string;
        }[]
      ).map((r) => ({ seq: r.seq, entity: r.entity, entityId: r.entity_id, contentHash: r.content_hash, sourceId: r.source_id, reason: r.reason, receiptId: r.receipt_id, deletedAt: r.deleted_at }));
    },

    reapplyTombstones(tombstones) {
      return runDeletion('restore_reapply', `tombstones:${tombstones.length}`, (counts, pend) => {
        for (const t of tombstones) {
          switch (t.entity) {
            case 'fact':
              if (q.fact.get(t.entityId)) deleteFactRows(t.entityId, counts, pend);
              break;
            case 'fact_version': {
              const m = /^(.*)#(\d+)$/.exec(t.entityId);
              if (!m) break;
              const fid = m[1]!;
              const ver = Number(m[2]);
              const f = q.fact.get(fid) as FactRow | undefined;
              if (!f || !q.version.get(fid, ver)) break;
              if (f.current_version === ver) {
                deleteFactRows(fid, counts, pend); // never resurrect deleted content as "current"
              } else {
                const row = q.version.get(fid, ver) as unknown as VersionRow;
                db.prepare('DELETE FROM memory_fact_versions WHERE fact_id = ? AND version = ?').run(fid, ver);
                pend.push({ entity: 'fact_version', entityId: t.entityId, hash: row.content_hash, sourceId: row.source_id });
                counts.factVersions += 1;
              }
              break;
            }
            case 'style_corpus':
              addDerived(deleteCorpusById(db, t.entityId), counts, pend);
              break;
            case 'style_example':
              addDerived({ corpus: [], examples: deleteExampleById(db, t.entityId) }, counts, pend);
              break;
            case 'source': {
              const s = getSource(t.entityId);
              for (const fid of factIdsFromSource(t.entityId)) deleteFactRows(fid, counts, pend);
              addDerived(deleteDerivedBySource(db, t.entityId), counts, pend);
              db.prepare('DELETE FROM style_cursors WHERE source_id = ?').run(t.entityId);
              if (!s) {
                db.prepare('INSERT INTO memory_sources (id, kind, label, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)').run(t.entityId, 'revoked', null, t.deletedAt, t.deletedAt);
              } else if (!s.revokedAt) {
                db.prepare('UPDATE memory_sources SET revoked_at = ? WHERE id = ?').run(t.deletedAt, t.entityId);
              }
              if (!s || !s.revokedAt) {
                counts.sourcesRevoked += 1;
                pend.push({ entity: 'source', entityId: t.entityId, hash: null, sourceId: t.entityId });
              }
              break;
            }
          }
        }
      });
    },

    receipts(limit = 50) {
      return (
        db.prepare('SELECT * FROM memory_deletion_receipts ORDER BY at DESC, id DESC LIMIT ?').all(limit) as {
          id: string;
          reason: DeletionReceipt['reason'];
          target: string;
          counts_json: string;
          at: string;
          receipt_hash: string;
        }[]
      ).map((r) => {
        const t = db.prepare('SELECT MIN(seq) AS a, MAX(seq) AS b, COUNT(*) AS n FROM memory_tombstones WHERE receipt_id = ?').get(r.id) as { a: number | null; b: number | null; n: number };
        return {
          id: r.id,
          reason: r.reason,
          target: r.target,
          at: r.at,
          counts: JSON.parse(r.counts_json) as DeletionCounts,
          tombstones: { firstSeq: t.a, lastSeq: t.b, count: t.n },
          receiptHash: r.receipt_hash,
          journalWritten: false,
        };
      });
    },
  };
  return store;
}
