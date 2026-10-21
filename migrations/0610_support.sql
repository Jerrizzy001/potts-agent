-- WP-7: customer-support drafts. Every inbound support message gets one row: its
-- classification, the reply drafted (if any), the knowledge items cited (ids + content
-- hashes + knowledge-base version) and what was done with it. Shadow mode only ever
-- writes rows here; it never proposes a broker action.

CREATE TABLE support_drafts (
  id                     TEXT PRIMARY KEY,
  channel_id             TEXT NOT NULL,
  app                    TEXT NOT NULL,
  inbound_message_id     TEXT NOT NULL,
  customer_address       TEXT NOT NULL,
  inbound_subject        TEXT,
  inbound_text           TEXT NOT NULL,
  inbound_hash           TEXT NOT NULL,
  received_at            TEXT NOT NULL,
  category               TEXT NOT NULL CHECK (category IN ('customer_support','personal_business_opportunity','protected','unclassified')),
  confidence             REAL NOT NULL,
  protected_reasons_json TEXT NOT NULL,
  signals_json           TEXT NOT NULL,
  reply_subject          TEXT,
  reply_text             TEXT,
  composer               TEXT NOT NULL CHECK (composer IN ('verbatim','holding_template','none')),
  knowledge_ids_json     TEXT NOT NULL,
  knowledge_hashes_json  TEXT NOT NULL,
  kb_version             TEXT NOT NULL,
  effective_mode         TEXT NOT NULL CHECK (effective_mode IN ('shadow','automatic')),
  automatic_eligible     INTEGER NOT NULL,
  eligibility_reasons_json TEXT NOT NULL,
  disposition            TEXT NOT NULL CHECK (disposition IN ('shadow_draft','channel_disabled','proposed_automatic','proposed_for_approval','proposal_rejected','no_reply')),
  action_id              TEXT,
  action_kind            TEXT,
  decision               TEXT,
  created_at             TEXT NOT NULL,
  UNIQUE (channel_id, inbound_message_id)
);
CREATE INDEX support_drafts_created ON support_drafts(created_at);
CREATE INDEX support_drafts_disposition ON support_drafts(disposition, created_at);
