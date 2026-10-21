-- WP-7: owner alert calls. Attempts are rows in owner_alert_calls (inserted BEFORE the
-- provider call), so a restart can never reset the per-incident attempt count.

CREATE TABLE owner_alert_incidents (
  id                TEXT PRIMARY KEY,          -- incident id from the monitoring/notification layer
  trigger_kind      TEXT NOT NULL,
  label             TEXT,
  status            TEXT NOT NULL CHECK (status IN ('active','acknowledged','resolved','exhausted','cancelled')),
  next_attempt_at   TEXT NOT NULL,
  pending_action_id TEXT,                      -- a proposed-but-held call action awaiting dispatch
  status_reason     TEXT,
  acknowledged_at   TEXT,
  acknowledged_call TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX owner_alert_incidents_due ON owner_alert_incidents(status, next_attempt_at);

CREATE TABLE owner_alert_calls (
  id                TEXT PRIMARY KEY,
  incident_id       TEXT NOT NULL REFERENCES owner_alert_incidents(id),
  attempt           INTEGER NOT NULL CHECK (attempt >= 1),
  action_id         TEXT NOT NULL UNIQUE,
  dispatch_id       TEXT,
  provider          TEXT NOT NULL,
  provider_call_id  TEXT UNIQUE,
  status            TEXT NOT NULL,             -- placing|rejected|uncertain|not_placed|queued|initiated|ringing|in-progress|completed|busy|no-answer|failed|canceled
  answered_by       TEXT,                      -- human|machine_start|fax|unknown... (NOT acknowledgement)
  acknowledged      INTEGER NOT NULL DEFAULT 0,-- only set by an explicit DTMF "1"
  duration_seconds  INTEGER,
  price             TEXT,                      -- provider-reported (Twilio: negative decimal string)
  price_unit        TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (incident_id, attempt)
);
CREATE INDEX owner_alert_calls_incident ON owner_alert_calls(incident_id, attempt);

-- Webhook replay protection: one row per distinct callback.
CREATE TABLE telephony_webhook_seen (
  dedupe_key   TEXT PRIMARY KEY,
  path         TEXT NOT NULL,
  call_sid     TEXT,
  received_at  TEXT NOT NULL
);

-- Minimal callback log (selected fields only; no auth material).
CREATE TABLE telephony_webhook_events (
  id           TEXT PRIMARY KEY,
  call_id      TEXT,
  call_sid     TEXT,
  path         TEXT NOT NULL,
  outcome      TEXT NOT NULL,                 -- applied|duplicate|stale|unknown_call|sid_mismatch|bad_signature|ignored
  fields_json  TEXT NOT NULL,
  received_at  TEXT NOT NULL
);
CREATE INDEX telephony_webhook_events_call ON telephony_webhook_events(call_id, received_at);
