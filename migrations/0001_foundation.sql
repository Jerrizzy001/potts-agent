-- WP-1 foundation: actions, approvals, dispatches, owner controls, ingress replay guard, audit ledger.
-- All instants are UTC ISO-8601 strings.

CREATE TABLE actions (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,
  actor              TEXT NOT NULL,
  account_id         TEXT,
  integration        TEXT,
  destination_json   TEXT NOT NULL,          -- canonical JSON array of exact recipients/targets
  payload_json       TEXT NOT NULL,          -- canonical JSON
  payload_hash       TEXT NOT NULL,
  attachments_json   TEXT NOT NULL,          -- canonical JSON array of {name, sha256}
  scope_json         TEXT,
  summary            TEXT,                   -- proposer rationale shown to owner; not authority, not bound
  revision           INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL CHECK (status IN ('held','denied','awaiting_approval','ready','dispatching','succeeded','failed','uncertain','cancelled')),
  decision           TEXT NOT NULL CHECK (decision IN ('allow','require_approval','hold','deny')),
  decision_reasons_json TEXT NOT NULL,
  policy_version     TEXT NOT NULL,
  policy_hash        TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX actions_status ON actions(status, updated_at);
CREATE INDEX actions_account ON actions(account_id);

CREATE TABLE approvals (
  id               TEXT PRIMARY KEY,
  action_id        TEXT NOT NULL REFERENCES actions(id),
  status           TEXT NOT NULL CHECK (status IN ('pending','approved','used','denied','cancelled','expired','invalidated')),
  source           TEXT NOT NULL CHECK (source IN ('request','direct_instruction')),
  binding_json     TEXT NOT NULL,
  binding_hash     TEXT NOT NULL,
  account_id       TEXT,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  decided_at       TEXT,
  decided_by       TEXT,
  ingress_ref      TEXT,
  used_at          TEXT,
  used_by_dispatch TEXT,
  status_reason    TEXT
);
-- At most one live (pending/approved) approval per action.
CREATE UNIQUE INDEX approvals_one_live ON approvals(action_id) WHERE status IN ('pending','approved');
CREATE INDEX approvals_status ON approvals(status, expires_at);

CREATE TABLE dispatches (
  id                    TEXT PRIMARY KEY,
  action_id             TEXT NOT NULL REFERENCES actions(id),
  attempt               INTEGER NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN ('dispatching','succeeded','failed','uncertain','reconciled_sent','reconciled_not_sent')),
  approval_id           TEXT REFERENCES approvals(id),
  executor              TEXT NOT NULL,
  intent_json           TEXT NOT NULL,
  intent_hash           TEXT NOT NULL,
  provider_operation_id TEXT,
  error                 TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (action_id, attempt)
);
-- Anti-duplicate invariant: at most one dispatch per action that may have reached the provider.
CREATE UNIQUE INDEX dispatches_one_possible_send ON dispatches(action_id)
  WHERE state IN ('dispatching','succeeded','uncertain','reconciled_sent');

CREATE TABLE controls (
  scope    TEXT PRIMARY KEY,                  -- 'global' | 'integration:<name>' | 'account:<id>'
  state    TEXT NOT NULL CHECK (state IN ('paused','revoked')),
  reason   TEXT,
  set_by   TEXT NOT NULL,
  set_at   TEXT NOT NULL
);

CREATE TABLE ingress_consumed (
  source      TEXT NOT NULL,
  update_id   TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  PRIMARY KEY (source, update_id)
);

CREATE TABLE audit_log (
  seq        INTEGER PRIMARY KEY,
  id         TEXT NOT NULL UNIQUE,
  at         TEXT NOT NULL,
  type       TEXT NOT NULL,
  actor      TEXT NOT NULL,
  action_id  TEXT,
  data_json  TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE
);
CREATE INDEX audit_action ON audit_log(action_id, seq);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
