-- WP-5 owner notification outbox, urgent events and briefing log.

CREATE TABLE urgent_events (
  id               TEXT PRIMARY KEY,
  dedup_key        TEXT NOT NULL UNIQUE,
  source_type      TEXT NOT NULL CHECK (source_type IN ('website_outage','website_degraded','monitor_auth','task_due','interview_invitation','business_enquiry','other')),
  source_ref       TEXT NOT NULL,
  title            TEXT NOT NULL,
  detail_json      TEXT NOT NULL DEFAULT '{}', -- ids, timestamps, status codes; never message bodies
  should_call      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL CHECK (status IN ('open','acknowledged','resolved')),
  created_at       TEXT NOT NULL,
  acknowledged_at  TEXT,
  acknowledged_by  TEXT,
  resolved_at      TEXT,
  resolution       TEXT,
  updated_at       TEXT NOT NULL
);
CREATE INDEX urgent_events_status ON urgent_events(status, created_at);
CREATE INDEX urgent_events_source ON urgent_events(source_type, source_ref);

CREATE TABLE owner_notifications (
  id                  TEXT PRIMARY KEY,
  dedup_key           TEXT NOT NULL UNIQUE,
  category            TEXT NOT NULL CHECK (category IN ('urgent','important','routine','briefing','approval_request','reply')),
  event_ref           TEXT,                    -- urgent event id / approval id / incident id
  text                TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  not_before_ms       INTEGER NOT NULL,
  expires_at_ms       INTEGER,
  status              TEXT NOT NULL CHECK (status IN ('pending','sending','delivered','dropped','folded','failed','uncertain')),
  held_since_ms       INTEGER,                 -- set when quiet hours held it at dispatch time
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_ms     INTEGER NOT NULL,
  last_error          TEXT,
  provider_message_id TEXT,
  delivered_at        TEXT,
  drop_reason         TEXT,
  folded_into         TEXT,                    -- briefing dedup key that included it
  updated_at          TEXT NOT NULL
);
CREATE INDEX owner_notifications_due ON owner_notifications(status, next_attempt_ms);

-- Delivery attempt log. A row is written in state 'sending' BEFORE the channel is called,
-- so a crash leaves evidence and the notification becomes 'uncertain' (never auto-resent).
CREATE TABLE owner_delivery_attempts (
  id                  TEXT PRIMARY KEY,
  notification_id     TEXT NOT NULL REFERENCES owner_notifications(id),
  attempt             INTEGER NOT NULL,
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  outcome             TEXT NOT NULL CHECK (outcome IN ('sending','delivered','rejected','uncertain')),
  provider_message_id TEXT,
  error               TEXT,
  UNIQUE (notification_id, attempt)
);
-- At most one attempt per notification that may have reached the owner.
CREATE UNIQUE INDEX owner_delivery_one_possible ON owner_delivery_attempts(notification_id)
  WHERE outcome IN ('sending','delivered','uncertain');

CREATE TABLE briefing_log (
  dedup_key      TEXT PRIMARY KEY,             -- briefing:<id>:<slot>
  briefing_id    TEXT NOT NULL,
  kind           TEXT NOT NULL,
  slot_key       TEXT NOT NULL,
  material_hash  TEXT NOT NULL,
  item_count     INTEGER NOT NULL,
  late           INTEGER NOT NULL DEFAULT 0,
  summarized     INTEGER NOT NULL DEFAULT 0,
  parts          INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX briefing_log_created ON briefing_log(created_at);
