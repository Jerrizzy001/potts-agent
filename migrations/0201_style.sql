-- WP-3 writing style: the local (filtered, PII-scrubbed) corpus of owner-authored
-- messages, the representative example set, reader cursors, builds and
-- owner review samples. Raw chat.db content is never copied here; only
-- owner-authored messages that passed the sensitive-content filter, scrubbed.

CREATE TABLE style_corpus (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL,          -- memory_sources.id (e.g. src_imessage_local)
  source_ref     TEXT NOT NULL,          -- e.g. imessage:rowid:123
  register       TEXT NOT NULL CHECK (register IN ('casual','professional')),
  register_score REAL NOT NULL,
  chat_kind      TEXT NOT NULL CHECK (chat_kind IN ('individual','group','unknown')),
  recipient_kind TEXT NOT NULL,          -- phone | email_personal | email_work | mixed | unknown (never the handle)
  text           TEXT NOT NULL,          -- scrubbed
  text_hash      TEXT NOT NULL,          -- sha256 of normalized scrubbed text
  sent_at        TEXT,
  ingested_at    TEXT NOT NULL,
  UNIQUE (source_id, source_ref)
);
CREATE INDEX style_corpus_register ON style_corpus(register);
CREATE INDEX style_corpus_hash ON style_corpus(text_hash);

CREATE TABLE style_examples (
  id          TEXT PRIMARY KEY,
  register    TEXT NOT NULL CHECK (register IN ('casual','professional')),
  text        TEXT NOT NULL,             -- scrubbed
  text_hash   TEXT NOT NULL,
  corpus_id   TEXT REFERENCES style_corpus(id) ON DELETE CASCADE,
  fact_id     TEXT,                      -- memory_facts.id when derived from a fact (e.g. owner-approved sample)
  source_id   TEXT NOT NULL,
  source_ref  TEXT,
  origin      TEXT NOT NULL CHECK (origin IN ('corpus','owner_approved')),
  created_at  TEXT NOT NULL,
  UNIQUE (register, text_hash)
);
CREATE INDEX style_examples_fact ON style_examples(fact_id);
CREATE INDEX style_examples_source ON style_examples(source_id);

CREATE VIRTUAL TABLE style_examples_fts USING fts5(
  example_id UNINDEXED,
  register UNINDEXED,
  text,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

CREATE TABLE style_cursors (
  source_id   TEXT PRIMARY KEY,
  last_rowid  INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE style_builds (
  id              TEXT PRIMARY KEY,
  built_at        TEXT NOT NULL,
  source_ids_json TEXT NOT NULL,
  counts_json     TEXT NOT NULL,         -- counts only, never content
  stats_hash      TEXT NOT NULL,
  guide_paths_json TEXT NOT NULL,
  stale_at        TEXT
);

CREATE TABLE style_review_samples (
  id          TEXT PRIMARY KEY,
  register    TEXT NOT NULL CHECK (register IN ('casual','professional')),
  scenario    TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  example_ids_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  rating      INTEGER CHECK (rating BETWEEN 1 AND 5),
  rated_at    TEXT,
  fact_id     TEXT                       -- feedback fact in memory
);
