import { strict as assert } from 'node:assert';
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { createFakeClock } from '../../src/core/index.ts';
import { openDatabase } from '../../src/store/index.ts';
import { createMemoryStore, OWNER_SOURCE_ID, readTombstoneJournal, memoryConfigFrom, validateSchemaForMemory } from './_imports.ts';
import { memEnv } from './helpers.ts';

function addSource(env: ReturnType<typeof memEnv>, id: string, kind: string) {
  const r = env.memory.registerSource({ id, kind, label: `${kind} test` });
  assert.ok(r.ok);
  return r.value;
}

test('remember stores provenance: source, kind, ref, timestamps, confidence, status', () => {
  const env = memEnv();
  try {
    addSource(env, 'src_gmail_a', 'gmail');
    const r = env.memory.remember({
      text: 'Interview with Examplecorp is on Thursday at 2pm',
      sourceId: 'src_gmail_a',
      sourceRef: 'gmail:msg:abc123',
      observedAt: '2026-10-05T18:00:00.000Z',
      status: 'draft',
      confidence: 0.7,
      tags: ['interview'],
    });
    assert.ok(r.ok);
    const f = r.value;
    assert.equal(f.current.sourceId, 'src_gmail_a');
    assert.equal(f.current.sourceKind, 'gmail');
    assert.equal(f.current.sourceRef, 'gmail:msg:abc123');
    assert.equal(f.current.observedAt, '2026-10-05T18:00:00.000Z');
    assert.equal(f.current.recordedAt, '2026-10-06T13:00:00.000Z');
    assert.equal(f.current.status, 'draft');
    assert.equal(f.current.confidence, 0.7);
    assert.match(f.current.contentHash, /^[0-9a-f]{64}$/);
    const insp = env.memory.inspect(f.id);
    assert.ok(insp.ok);
    assert.equal(insp.value.sources[0]!.kind, 'gmail');
  } finally {
    env.cleanup();
  }
});

test('remember validates input and model writes can never be verified', () => {
  const env = memEnv();
  try {
    assert.equal(env.memory.remember({ text: 'x', sourceId: 'nope', status: 'draft', confidence: 0.5 }).ok, false);
    const m = env.memory.remember({ text: 'owner likes tea', sourceId: OWNER_SOURCE_ID, status: 'verified', confidence: 1, actor: 'model' });
    assert.equal(m.ok, false);
    if (!m.ok) assert.equal(m.error.code, 'denied');
    assert.equal(env.memory.remember({ text: 'ok', sourceId: OWNER_SOURCE_ID, status: 'verified', confidence: 2 }).ok, false);
    addSource(env, 'src_inf', 'potts_inference');
    assert.equal(env.memory.remember({ text: 'probably prefers mornings', sourceId: 'src_inf', status: 'draft', confidence: 0.4 }).ok, false);
    assert.equal(env.memory.remember({ text: 'probably prefers mornings', sourceId: 'src_inf', status: 'inferred', confidence: 0.4, actor: 'model' }).ok, true);
  } finally {
    env.cleanup();
  }
});

test('corrections create versions; old versions retained as superseded; search sees only current', () => {
  const env = memEnv();
  try {
    const f = env.memory.remember({ text: 'Dentist appointment on Monday', sourceId: OWNER_SOURCE_ID, status: 'draft', confidence: 0.6, actor: 'owner' });
    assert.ok(f.ok);
    env.clock.advanceSeconds(60);
    const c1 = env.memory.correct(f.value.id, { text: 'Dentist appointment on Tuesday', reason: 'moved by clinic' });
    assert.ok(c1.ok);
    env.clock.advanceSeconds(60);
    const c2 = env.memory.correct(f.value.id, { confidence: 0.9, status: 'draft', reason: 'less sure', actor: 'system' });
    assert.ok(c2.ok);
    const insp = env.memory.inspect(f.value.id);
    assert.ok(insp.ok);
    const vs = insp.value.versions;
    assert.equal(vs.length, 3);
    assert.equal(vs[0]!.text, 'Dentist appointment on Monday');
    assert.equal(vs[0]!.supersededAt, '2026-10-06T13:01:00.000Z');
    assert.equal(vs[1]!.status, 'verified'); // owner correction defaults to verified
    assert.equal(vs[1]!.correctionReason, 'moved by clinic');
    assert.equal(vs[1]!.actor, 'owner');
    assert.equal(vs[2]!.supersededAt, null);
    assert.equal(insp.value.currentVersion, 3);
    assert.equal(env.memory.search('Monday').length, 0);
    assert.equal(env.memory.search('Tuesday dentist').length, 1);
    assert.equal(env.memory.correct(f.value.id, { reason: 'noop', confidence: 0.9, status: 'draft' }).ok, false);
    assert.equal(env.memory.correct(f.value.id, { text: 'x', reason: '' }).ok, false);
  } finally {
    env.cleanup();
  }
});

test('search ranks verified above draft and filters by status and source', () => {
  const env = memEnv();
  try {
    addSource(env, 'src_mail', 'gmail');
    const a = env.memory.remember({ text: 'Project Falcon deadline is Friday', sourceId: 'src_mail', status: 'draft', confidence: 0.5 });
    const b = env.memory.remember({ text: 'Project Falcon deadline is Friday at noon', sourceId: OWNER_SOURCE_ID, status: 'verified', confidence: 1, actor: 'owner' });
    env.memory.remember({ text: 'Unrelated grocery list', sourceId: OWNER_SOURCE_ID, status: 'verified', confidence: 1 });
    assert.ok(a.ok && b.ok);
    const hits = env.memory.search('falcon deadline');
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.fact.id, b.value.id);
    assert.deepEqual(env.memory.search('falcon', { statuses: ['draft'] }).map((h) => h.fact.id), [a.value.id]);
    assert.deepEqual(env.memory.search('falcon', { sourceKinds: ['gmail'] }).map((h) => h.fact.id), [a.value.id]);
    assert.deepEqual(env.memory.search('falcon', { sourceIds: [OWNER_SOURCE_ID] }).map((h) => h.fact.id), [b.value.id]);
    // Query syntax is neutralised (no FTS injection / errors).
    assert.doesNotThrow(() => env.memory.search('falcon" OR text:* NEAR('));
    assert.equal(env.memory.search('   ').length, 0);
    // OR fallback when not all terms match.
    assert.ok(env.memory.search('falcon zebra').length >= 1);
  } finally {
    env.cleanup();
  }
});

test('forget hard-deletes fact, versions, FTS rows, embeddings and derived style examples; returns receipt; content leaves the DB file', () => {
  const env = memEnv();
  try {
    const secret = 'Zanzibarquokka favourite restaurant is Pizzeria Uno';
    const f = env.memory.remember({ text: secret, sourceId: OWNER_SOURCE_ID, status: 'verified', confidence: 1, actor: 'owner' });
    assert.ok(f.ok);
    env.memory.correct(f.value.id, { text: secret + ' downtown', reason: 'more precise' });
    env.db
      .prepare("INSERT INTO style_examples (id, register, text, text_hash, fact_id, source_id, origin, created_at) VALUES ('sx_1','casual','zanzibarquokka example text','h1',?,?,'owner_approved','2026-10-06T13:00:00.000Z')")
      .run(f.value.id, OWNER_SOURCE_ID);
    env.db.prepare("INSERT INTO style_examples_fts (example_id, register, text) VALUES ('sx_1','casual','zanzibarquokka example text')").run();
    env.db.prepare('INSERT INTO memory_embeddings (fact_id, version, model, dim, vector, created_at) VALUES (?, 2, ?, 2, ?, ?)').run(f.value.id, 'm', new Uint8Array(8), env.clock.nowIso());
    const pv = env.memory.previewForget(f.value.id);
    assert.ok(pv.ok);
    assert.equal(pv.value.factVersions, 2);
    assert.equal(pv.value.styleExamples, 1);

    const r = env.memory.forget(f.value.id);
    assert.ok(r.ok);
    const rc = r.value;
    assert.equal(rc.reason, 'forget');
    assert.deepEqual(rc.counts, { facts: 1, factVersions: 2, ftsRows: 1, embeddings: 1, styleCorpus: 0, styleExamples: 1, sourcesRevoked: 0 });
    assert.match(rc.receiptHash, /^[0-9a-f]{64}$/);
    assert.equal(rc.journalWritten, true);
    assert.equal(env.memory.get(f.value.id), undefined);
    assert.equal(env.memory.search('zanzibarquokka').length, 0);
    const n = (sql: string) => (env.db.prepare(sql).get() as { n: number }).n;
    assert.equal(n("SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH 'zanzibarquokka'"), 0);
    assert.equal(n('SELECT COUNT(*) AS n FROM memory_fact_versions'), 0);
    assert.equal(n('SELECT COUNT(*) AS n FROM style_examples'), 0);
    assert.equal(n("SELECT COUNT(*) AS n FROM style_examples_fts WHERE style_examples_fts MATCH 'zanzibarquokka'"), 0);
    assert.equal(n('SELECT COUNT(*) AS n FROM memory_embeddings'), 0);
    // Tombstones: ids/hashes only, never content.
    const ts = env.memory.listTombstones();
    assert.deepEqual(ts.map((t) => t.entity).sort(), ['fact', 'fact_version', 'fact_version', 'style_example']);
    assert.ok(!JSON.stringify(ts).toLowerCase().includes('zanzibarquokka'));
    assert.ok(!readFileSync(env.journal, 'utf8').toLowerCase().includes('zanzibarquokka'));
    assert.equal(statSync(env.journal).mode & 0o777, 0o600);
    // The text must not survive in the database file or WAL (secure_delete + FTS optimize + checkpoint).
    env.db.close();
    for (const p of [env.dbPath, env.dbPath + '-wal']) {
      if (existsSync(p)) assert.ok(!readFileSync(p).includes(Buffer.from('anzibarquokka')), `forgotten text found in ${p}`);
    }
    // Tombstone table is append-only.
    const db2 = openDatabase(env.dbPath);
    assert.throws(() => db2.exec('DELETE FROM memory_tombstones'));
    db2.close();
  } finally {
    env.cleanup();
  }
});

test('revokeSource forgets every fact, corpus row and example from the source and blocks further ingestion', () => {
  const env = memEnv();
  try {
    addSource(env, 'src_imsg', 'imessage');
    addSource(env, 'src_keep', 'gmail');
    const a = env.memory.remember({ text: 'Alpha fact from messages', sourceId: 'src_imsg', status: 'inferred', confidence: 0.5 });
    const b = env.memory.remember({ text: 'Beta fact from mail', sourceId: 'src_keep', status: 'draft', confidence: 0.5 });
    const c = env.memory.remember({ text: 'Gamma fact owner said', sourceId: OWNER_SOURCE_ID, status: 'verified', confidence: 1 });
    assert.ok(a.ok && b.ok && c.ok);
    // A fact originally from the revoked source but later corrected by the owner is still derived from it.
    env.memory.correct(c.value.id, { text: 'Gamma fact refined', reason: 'r', sourceId: 'src_imsg', actor: 'system' });
    env.db
      .prepare("INSERT INTO style_corpus (id, source_id, source_ref, register, register_score, chat_kind, recipient_kind, text, text_hash, ingested_at) VALUES ('sc_1','src_imsg','imessage:rowid:1','casual',0,'individual','phone','yo whats up','hh', ?)")
      .run(env.clock.nowIso());
    env.db.prepare("INSERT INTO style_examples (id, register, text, text_hash, corpus_id, source_id, source_ref, origin, created_at) VALUES ('sx_c','casual','yo whats up','hh','sc_1','src_imsg','imessage:rowid:1','corpus',?)").run(env.clock.nowIso());
    env.db.prepare("INSERT INTO style_examples_fts (example_id, register, text) VALUES ('sx_c','casual','yo whats up')").run();
    env.db.prepare("INSERT INTO style_cursors (source_id, last_rowid, updated_at) VALUES ('src_imsg', 99, ?)").run(env.clock.nowIso());
    env.db.prepare("INSERT INTO style_builds (id, built_at, source_ids_json, counts_json, stats_hash, guide_paths_json) VALUES ('sb_1', ?, '[\"src_imsg\"]', '{}', 'x', '[]')").run(env.clock.nowIso());

    const pv = env.memory.previewRevokeSource('src_imsg');
    assert.ok(pv.ok);
    assert.equal(pv.value.facts, 2);
    const r = env.memory.revokeSource('src_imsg');
    assert.ok(r.ok);
    assert.equal(r.value.counts.facts, 2);
    assert.equal(r.value.counts.styleCorpus, 1);
    assert.equal(r.value.counts.styleExamples, 1);
    assert.equal(r.value.counts.sourcesRevoked, 1);
    assert.equal(env.memory.get(a.value.id), undefined);
    assert.equal(env.memory.get(c.value.id), undefined);
    assert.ok(env.memory.get(b.value.id));
    assert.ok(env.memory.getSource('src_imsg')!.revokedAt);
    const again = env.memory.remember({ text: 'more', sourceId: 'src_imsg', status: 'draft', confidence: 0.1 });
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.error.code, 'revoked');
    const n = (sql: string) => (env.db.prepare(sql).get() as { n: number }).n;
    assert.equal(n('SELECT COUNT(*) AS n FROM style_corpus'), 0);
    assert.equal(n('SELECT COUNT(*) AS n FROM style_cursors'), 0);
    assert.equal(n('SELECT COUNT(*) AS n FROM style_builds WHERE stale_at IS NOT NULL'), 1);
    assert.equal(env.memory.revokeSource(OWNER_SOURCE_ID).ok, false);
  } finally {
    env.cleanup();
  }
});

test('forgetSourceRef removes facts and style rows derived from one item', () => {
  const env = memEnv();
  try {
    addSource(env, 'src_imsg', 'imessage');
    const a = env.memory.remember({ text: 'from message one', sourceId: 'src_imsg', sourceRef: 'imessage:rowid:1', status: 'inferred', confidence: 0.3 });
    const b = env.memory.remember({ text: 'from message two', sourceId: 'src_imsg', sourceRef: 'imessage:rowid:2', status: 'inferred', confidence: 0.3 });
    assert.ok(a.ok && b.ok);
    env.db
      .prepare("INSERT INTO style_corpus (id, source_id, source_ref, register, register_score, chat_kind, recipient_kind, text, text_hash, ingested_at) VALUES ('sc_1','src_imsg','imessage:rowid:1','casual',0,'individual','phone','t','h', ?)")
      .run(env.clock.nowIso());
    const r = env.memory.forgetSourceRef('src_imsg', 'imessage:rowid:1');
    assert.ok(r.ok);
    assert.equal(r.value.counts.facts, 1);
    assert.equal(r.value.counts.styleCorpus, 1);
    assert.equal(env.memory.get(a.value.id), undefined);
    assert.ok(env.memory.get(b.value.id));
    assert.ok(!r.value.target.includes('rowid'), 'receipt target must not expose the ref');
  } finally {
    env.cleanup();
  }
});

test('retention purge: per source kind, whole facts and expired superseded versions, corpus rows; receipts', () => {
  const env = memEnv({ retention: { imessage: { days: 30 }, potts_inference: { days: 7, basis: 'observed' }, owner_stated: { days: null } } });
  try {
    addSource(env, 'src_imsg', 'imessage');
    addSource(env, 'src_inf', 'potts_inference');
    const old = env.memory.remember({ text: 'old message fact', sourceId: 'src_imsg', status: 'inferred', confidence: 0.4 });
    const mixed = env.memory.remember({ text: 'message fact later corrected', sourceId: 'src_imsg', status: 'inferred', confidence: 0.4 });
    const inf = env.memory.remember({ text: 'inference observed long ago', sourceId: 'src_inf', status: 'inferred', confidence: 0.4, observedAt: '2026-01-01T00:00:00.000Z' });
    const owner = env.memory.remember({ text: 'owner fact forever', sourceId: OWNER_SOURCE_ID, status: 'verified', confidence: 1 });
    assert.ok(old.ok && mixed.ok && inf.ok && owner.ok);
    env.db
      .prepare("INSERT INTO style_corpus (id, source_id, source_ref, register, register_score, chat_kind, recipient_kind, text, text_hash, ingested_at) VALUES ('sc_old','src_imsg','r1','casual',0,'individual','phone','t','h', ?)")
      .run(env.clock.nowIso());
    env.clock.advanceSeconds(20 * 86400);
    env.memory.correct(mixed.value.id, { text: 'message fact confirmed by owner', reason: 'confirmed' });
    env.db
      .prepare("INSERT INTO style_corpus (id, source_id, source_ref, register, register_score, chat_kind, recipient_kind, text, text_hash, ingested_at) VALUES ('sc_new','src_imsg','r2','casual',0,'individual','phone','t2','h2', ?)")
      .run(env.clock.nowIso());
    // 10 days later: inference (observed in January) is past 7 days; nothing from imessage is 30 days old yet.
    env.clock.advanceSeconds(10 * 86400 - 3600);
    let rs = env.memory.purgeExpired();
    assert.equal(rs.length, 1);
    assert.equal(rs[0]!.target, 'retention:potts_inference');
    assert.equal(env.memory.get(inf.value.id), undefined);
    // Past 30 days for the first imessage records.
    env.clock.advanceSeconds(2 * 3600);
    rs = env.memory.purgeExpired();
    assert.equal(rs.length, 1);
    assert.equal(rs[0]!.target, 'retention:imessage');
    assert.equal(rs[0]!.reason, 'retention');
    assert.equal(env.memory.get(old.value.id), undefined);
    const m = env.memory.inspect(mixed.value.id);
    assert.ok(m.ok, 'owner-corrected fact survives');
    assert.deepEqual(m.value.versions.map((v) => v.version), [2]);
    assert.ok(env.memory.get(owner.value.id));
    const corpus = env.db.prepare('SELECT id FROM style_corpus').all() as { id: string }[];
    assert.deepEqual(corpus.map((c) => c.id), ['sc_new']);
    assert.equal(env.memory.purgeExpired().length, 0);
    assert.equal(memoryConfigFrom({ memory: { retention: { imessage: { days: 5 } } } }).retention!.imessage!.days, 5);
    assert.equal(memoryConfigFrom(undefined).embeddings!.provider, 'disabled');
  } finally {
    env.cleanup();
  }
});

test('tombstones re-apply deletions after restoring an older backup (facts, versions, sources)', () => {
  const env = memEnv();
  try {
    addSource(env, 'src_bad', 'gmail');
    const a = env.memory.remember({ text: 'keep me', sourceId: OWNER_SOURCE_ID, status: 'verified', confidence: 1 });
    const b = env.memory.remember({ text: 'forget me later', sourceId: OWNER_SOURCE_ID, status: 'verified', confidence: 1 });
    const c = env.memory.remember({ text: 'from a source revoked later', sourceId: 'src_bad', status: 'draft', confidence: 0.5 });
    assert.ok(a.ok && b.ok && c.ok);
    env.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const backup = env.dbPath + '.backup';
    copyFileSync(env.dbPath, backup);
    assert.ok(env.memory.forget(b.value.id).ok);
    assert.ok(env.memory.revokeSource('src_bad').ok);

    const restored = openDatabase(backup);
    const clock = createFakeClock('2026-10-07T00:00:00.000Z');
    const mem2 = createMemoryStore({ db: restored, clock });
    assert.ok(mem2.get(b.value.id), 'backup still has the forgotten fact');
    const { tombstones, malformedLines } = readTombstoneJournal(env.journal);
    assert.equal(malformedLines, 0);
    const r = mem2.reapplyTombstones(tombstones);
    assert.equal(r.reason, 'restore_reapply');
    assert.equal(mem2.get(b.value.id), undefined);
    assert.equal(mem2.get(c.value.id), undefined);
    assert.ok(mem2.get(a.value.id));
    assert.ok(mem2.getSource('src_bad')!.revokedAt);
    assert.equal(mem2.remember({ text: 'x', sourceId: 'src_bad', status: 'draft', confidence: 0.1 }).ok, false);
    // Idempotent.
    const again = mem2.reapplyTombstones(tombstones);
    assert.equal(again.counts.facts, 0);
    assert.equal(again.counts.sourcesRevoked, 0);
    restored.close();
  } finally {
    env.cleanup();
  }
});

test('memory config section validates against potts.schema.json (loopback-only embeddings url)', () => {
  assert.equal(validateSchemaForMemory({ retention: { imessage: { days: 730 } }, embeddings: { provider: 'disabled' } }).length, 0);
  assert.equal(validateSchemaForMemory({ embeddings: { provider: 'lmstudio', url: 'http://127.0.0.1:1234/v1/embeddings', model: 'nomic' } }).length, 0);
  assert.ok(validateSchemaForMemory({ embeddings: { provider: 'lmstudio', url: 'https://api.openai.com/v1/embeddings' } }).length > 0);
  assert.ok(validateSchemaForMemory({ embeddings: { provider: 'openai' } }).length > 0);
  assert.ok(validateSchemaForMemory({ retention: { imessage: { days: 0 } } }).length > 0);
});
