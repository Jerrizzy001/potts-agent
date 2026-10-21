-- WP-3 local memory: sources, versioned facts with provenance, FTS5 index,
-- optional local embeddings, deletion receipts and content-free tombstones.
-- All instants are UTC ISO-8601 strings.

-- A source is where facts come from (a mailbox, the local iMessage archive,
-- the owner speaking on Telegram, Potts's own inference ...). Revoking a source
-- forgets everything derived from it and blocks further ingestion from it.
CREATE TABLE memory_sources (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  label       TEXT,
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);

-- Stable identity of a fact. Content lives in memory_fact_versions.
CREATE TABLE memory_facts (
  id               TEXT PRIMARY KEY,
  current_version  INTEGER NOT NULL,
  topic            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- Every version of every fact. A correction inserts a new version and marks
-- the previous one superseded; old versions are kept until the fact is
-- forgotten (hard delete of all versions).
CREATE TABLE memory_fact_versions (
  fact_id           TEXT NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL,
  text              TEXT NOT NULL,
  tags_json         TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL CHECK (status IN ('verified','draft','inferred')),
  confidence        REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_id         TEXT NOT NULL,
  source_kind       TEXT NOT NULL,
  source_ref        TEXT,                -- locator inside the source (message id, url, ...)
  observed_at       TEXT,                -- timestamp of the underlying evidence, if known
  recorded_at       TEXT NOT NULL,       -- when Potts stored this version
  actor             TEXT NOT NULL,       -- owner | system | model
  correction_reason TEXT,
  content_hash      TEXT NOT NULL,
  superseded_at     TEXT,
  PRIMARY KEY (fact_id, version)
);
CREATE INDEX memory_fact_versions_source ON memory_fact_versions(source_id);
CREATE INDEX memory_fact_versions_kind ON memory_fact_versions(source_kind, recorded_at);

-- Full-text index over the CURRENT version of each fact only.
CREATE VIRTUAL TABLE memory_fts USING fts5(
  fact_id UNINDEXED,
  text,
  tags,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- Optional local embeddings (only written when an enabled local provider is configured).
CREATE TABLE memory_embeddings (
  fact_id   TEXT NOT NULL,
  version   INTEGER NOT NULL,
  model     TEXT NOT NULL,
  dim       INTEGER NOT NULL,
  vector    BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (fact_id, version, model),
  FOREIGN KEY (fact_id, version) REFERENCES memory_fact_versions(fact_id, version) ON DELETE CASCADE
);

-- One receipt per deletion request (forget, revoke-source, retention purge).
CREATE TABLE memory_deletion_receipts (
  id           TEXT PRIMARY KEY,
  reason       TEXT NOT NULL CHECK (reason IN ('forget','revoke_source','retention','forget_source_ref','restore_reapply')),
  target       TEXT NOT NULL,            -- fact id / source id / "retention:<kind>" (never content)
  counts_json  TEXT NOT NULL,
  at           TEXT NOT NULL,
  receipt_hash TEXT NOT NULL
);

-- Content-free record of every deleted entity, so a restore from an older
-- backup can re-apply deletions (WP-8). Contains ids and hashes only.
CREATE TABLE memory_tombstones (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity       TEXT NOT NULL CHECK (entity IN ('fact','fact_version','style_corpus','style_example','source')),
  entity_id    TEXT NOT NULL,
  content_hash TEXT,
  source_id    TEXT,
  reason       TEXT NOT NULL,
  receipt_id   TEXT NOT NULL,
  deleted_at   TEXT NOT NULL
);
CREATE INDEX memory_tombstones_entity ON memory_tombstones(entity, entity_id);
CREATE TRIGGER memory_tombstones_no_update BEFORE UPDATE ON memory_tombstones
BEGIN SELECT RAISE(ABORT, 'memory_tombstones is append-only'); END;
CREATE TRIGGER memory_tombstones_no_delete BEFORE DELETE ON memory_tombstones
BEGIN SELECT RAISE(ABORT, 'memory_tombstones is append-only'); END;
