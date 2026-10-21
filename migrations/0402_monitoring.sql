-- WP-5 website monitoring: check evidence, streak state and incidents.

CREATE TABLE monitor_checks (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL,
  at            TEXT NOT NULL,
  at_ms         INTEGER NOT NULL,
  observation   TEXT NOT NULL,                 -- ok | outage | degraded | monitor_auth | rate_limited | mac_offline | maintenance
  check_name    TEXT NOT NULL,                 -- homepage | health | readiness | journey:<name> | connectivity
  ok            INTEGER NOT NULL,
  status_code   INTEGER,
  latency_ms    INTEGER,
  cause         TEXT                           -- http_5xx | timeout | dns | tls | network | rate_limited | auth | ...
);
CREATE INDEX monitor_checks_site ON monitor_checks(site_id, at_ms);

CREATE TABLE monitor_streaks (
  site_id               TEXT NOT NULL,
  incident_class        TEXT NOT NULL CHECK (incident_class IN ('outage','degraded','monitor_auth')),
  streak_start_ms       INTEGER,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  last_cause            TEXT,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (site_id, incident_class)
);

CREATE TABLE monitor_site_state (
  site_id            TEXT PRIMARY KEY,
  last_observation   TEXT NOT NULL,
  last_checked_at    TEXT NOT NULL,
  local_offline_since TEXT,
  rate_limited_until_ms INTEGER,
  updated_at         TEXT NOT NULL
);

CREATE TABLE incidents (
  id                TEXT PRIMARY KEY,
  site_id           TEXT NOT NULL,
  failure_class     TEXT NOT NULL CHECK (failure_class IN ('outage','degraded','monitor_auth')),
  cause             TEXT,
  status            TEXT NOT NULL CHECK (status IN ('open','acknowledged','resolved')),
  first_failure_at  TEXT NOT NULL,
  opened_at         TEXT NOT NULL,
  acknowledged_at   TEXT,
  acknowledged_by   TEXT,
  resolved_at       TEXT,
  resolution        TEXT,
  urgent_event_id   TEXT,
  updated_at        TEXT NOT NULL
);
-- Dedup: one unresolved incident per site + failure class.
CREATE UNIQUE INDEX incidents_one_unresolved ON incidents(site_id, failure_class) WHERE status IN ('open','acknowledged');
CREATE INDEX incidents_resolved ON incidents(resolved_at);

CREATE TABLE incident_evidence (
  id            TEXT PRIMARY KEY,
  incident_id   TEXT NOT NULL REFERENCES incidents(id),
  at            TEXT NOT NULL,
  check_name    TEXT NOT NULL,
  ok            INTEGER NOT NULL,
  status_code   INTEGER,
  latency_ms    INTEGER,
  cause         TEXT,
  note          TEXT
);
CREATE INDEX incident_evidence_incident ON incident_evidence(incident_id, at);
