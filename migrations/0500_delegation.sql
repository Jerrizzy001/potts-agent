-- WP-6 delegation: task tree (depth/cycle/budget limits), attempts, evidence reports, release rechecks.
-- All instants are UTC ISO-8601 strings.

CREATE TABLE delegation_tasks (
  task_id               TEXT PRIMARY KEY,
  parent_id             TEXT REFERENCES delegation_tasks(task_id),
  root_id               TEXT NOT NULL,
  depth                 INTEGER NOT NULL CHECK (depth >= 0),
  project_id            TEXT,
  kind                  TEXT NOT NULL,
  objective_fingerprint TEXT NOT NULL,             -- sha256 of normalized objective + project scope (cycle detection)
  route                 TEXT,                      -- local_qwen | claude_code | external_manual | owner
  status                TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','blocked','awaiting_owner','cancelled')),
  status_reason         TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL,
  deadline              TEXT NOT NULL,
  spec_json             TEXT NOT NULL,             -- canonical JSON of the validated task spec
  spec_hash             TEXT NOT NULL,
  purchase_action_id    TEXT,                      -- broker action id of a paid-usage purchase proposal, if any
  working_copy          TEXT,                      -- preserved worker working copy path (unfinished work is kept)
  base_sha              TEXT,                      -- commit the working copy was created from
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX delegation_tasks_root ON delegation_tasks(root_id);
CREATE INDEX delegation_tasks_status ON delegation_tasks(status);

CREATE TABLE delegation_runs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES delegation_tasks(task_id),
  attempt      INTEGER NOT NULL,
  worker       TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','error','timeout','allowance_exhausted','abandoned')),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  result_json  TEXT,
  UNIQUE (task_id, attempt)
);
-- A task never has two running attempts.
CREATE UNIQUE INDEX delegation_runs_one_running ON delegation_runs(task_id) WHERE status = 'running';

CREATE TABLE delegation_evidence (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES delegation_tasks(task_id),
  run_id         TEXT REFERENCES delegation_runs(id),
  base_sha       TEXT NOT NULL,
  candidate_sha  TEXT,
  report_json    TEXT NOT NULL,
  report_hash    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX delegation_evidence_task ON delegation_evidence(task_id);

CREATE TABLE release_rechecks (
  id            TEXT PRIMARY KEY,
  action_id     TEXT NOT NULL REFERENCES actions(id),
  result        TEXT NOT NULL CHECK (result IN ('current','stale','error')),
  changed_json  TEXT NOT NULL,
  observed_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX release_rechecks_action ON release_rechecks(action_id);
