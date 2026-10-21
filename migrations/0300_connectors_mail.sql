-- WP-4: connector account status (OAuth consent/auth state), mail sync cursors and the shared mail item store.
-- All instants are UTC ISO-8601 strings. No tokens or secrets are stored here (tokens live in the TokenStore / Keychain).

CREATE TABLE connector_accounts (
  account_id        TEXT PRIMARY KEY,
  provider          TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
  status            TEXT NOT NULL CHECK (status IN ('not_connected','connected','stale_auth','admin_consent_required','revoked','error')),
  consented_address TEXT,            -- exact identity verified at consent time (profile email)
  scopes            TEXT,            -- space-separated scopes actually granted
  status_reason     TEXT,
  connected_at      TEXT,
  updated_at        TEXT NOT NULL
);

CREATE TABLE mail_sync_state (
  account_id        TEXT PRIMARY KEY,
  provider          TEXT NOT NULL CHECK (provider IN ('gmail','outlook')),
  cursor            TEXT,            -- Gmail historyId or Graph deltaLink (deltaLink has no secrets; it is an opaque URL token)
  last_full_sync_at TEXT,
  last_sync_at      TEXT,
  last_success_at   TEXT,
  status            TEXT NOT NULL CHECK (status IN ('never','ok','stale_auth','admin_consent_required','rate_limited','error','revoked','paused')),
  status_reason     TEXT,
  updated_at        TEXT NOT NULL
);

CREATE TABLE mail_items (
  account_id          TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  provider            TEXT NOT NULL CHECK (provider IN ('gmail','outlook')),
  thread_id           TEXT,
  internet_message_id TEXT,
  from_address        TEXT,
  from_name           TEXT,
  to_json             TEXT NOT NULL,
  cc_json             TEXT NOT NULL,
  subject             TEXT,
  snippet             TEXT,
  body_text           TEXT,
  body_source         TEXT CHECK (body_source IN ('text','html','none')),
  received_at         TEXT,
  labels_json         TEXT NOT NULL,
  headers_json        TEXT NOT NULL,   -- selected headers only (list-unsubscribe, precedence, auto-submitted, reply-to, ...)
  attachments_json    TEXT NOT NULL,   -- metadata only: [{name, mimeType, size, providerAttachmentId, inline}]
  content_hash        TEXT NOT NULL,
  category            TEXT NOT NULL,
  priority            TEXT NOT NULL CHECK (priority IN ('priority','normal','routine')),
  classification_json TEXT NOT NULL,   -- reasons, interview detection, injection flags
  injection_flagged   INTEGER NOT NULL DEFAULT 0,
  first_seen_at       TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT,
  PRIMARY KEY (account_id, provider_message_id)
);
CREATE INDEX mail_items_priority ON mail_items(priority, received_at);
CREATE INDEX mail_items_received ON mail_items(account_id, received_at);

CREATE TABLE mail_sync_log (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('full','incremental','full_after_expiry')),
  outcome      TEXT NOT NULL,
  inserted     INTEGER NOT NULL DEFAULT 0,
  updated      INTEGER NOT NULL DEFAULT 0,
  unchanged    INTEGER NOT NULL DEFAULT 0,
  deleted      INTEGER NOT NULL DEFAULT 0,
  detail       TEXT
);
CREATE INDEX mail_sync_log_account ON mail_sync_log(account_id, started_at);
