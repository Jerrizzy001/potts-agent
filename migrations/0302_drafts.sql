-- WP-4: local draft workspace metadata. Draft bodies live in separate files under $POTTS_HOME/drafts/.

CREATE TABLE drafts (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('resume','cover_letter','application','email_reply')),
  title            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('draft','ready_for_review','proposed','archived')),
  source_refs_json TEXT NOT NULL,     -- [{type, id, ...}]
  unresolved_json  TEXT NOT NULL,     -- unresolved facts / questions
  meta_json        TEXT NOT NULL,
  file_path        TEXT NOT NULL,     -- relative to the drafts directory
  content_sha256   TEXT NOT NULL,
  proposal_action_id TEXT,            -- broker action id once proposed (never executed by drafts code)
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX drafts_kind ON drafts(kind, status);
