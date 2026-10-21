-- WP-5 scheduler: the single durable job authority.
-- Instants are stored as UTC ISO strings plus integer epoch milliseconds for ordering.

CREATE TABLE sched_jobs (
  id                   TEXT PRIMARY KEY,
  def_json             TEXT NOT NULL,          -- canonical JSON of the job definition
  def_hash             TEXT NOT NULL,
  enabled              INTEGER NOT NULL DEFAULT 1,
  next_run_ms          INTEGER NOT NULL,
  next_run_at          TEXT NOT NULL,
  current_slot         TEXT,                   -- slot being retried (daily jobs), NULL when none
  current_slot_ms      INTEGER,
  slot_attempts        INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  folded_json          TEXT NOT NULL DEFAULT '[]', -- missed slot keys folded into the next run
  lease_owner          TEXT,
  lease_run_id         TEXT,
  lease_expires_ms     INTEGER,
  last_run_at          TEXT,
  last_success_at      TEXT,
  last_status          TEXT,
  last_error           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX sched_jobs_due ON sched_jobs(enabled, next_run_ms);

-- One row per schedule slot (daily: local date; interval: scheduled instant).
-- PRIMARY KEY guarantees a slot can never be recorded twice.
CREATE TABLE sched_slots (
  job_id        TEXT NOT NULL REFERENCES sched_jobs(id),
  slot_key      TEXT NOT NULL,
  scheduled_at  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('running','retrying','succeeded','failed','missed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  late          INTEGER NOT NULL DEFAULT 0,
  completed_at  TEXT,
  PRIMARY KEY (job_id, slot_key)
);

CREATE TABLE sched_runs (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES sched_jobs(id),
  slot_key      TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  scheduled_at  TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','abandoned','lease_lost')),
  late          INTEGER NOT NULL DEFAULT 0,
  lease_owner   TEXT NOT NULL,
  error         TEXT,
  detail_json   TEXT,
  UNIQUE (job_id, slot_key, attempt)
);
CREATE INDEX sched_runs_job ON sched_runs(job_id, started_at);

-- Small key/value store for WP-5 cursors (e.g. deadline watcher "since").
CREATE TABLE wp5_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
