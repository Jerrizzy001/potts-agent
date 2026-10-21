-- WP-9: deletion receipts for an account's synced data, written when the owner revokes the account.
-- Content-free: ids, counts and a hash only.

CREATE TABLE account_purge_receipts (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL,
  reason            TEXT NOT NULL,
  actor             TEXT NOT NULL,
  counts_json       TEXT NOT NULL,
  memory_receipt_id TEXT,
  at                TEXT NOT NULL,
  receipt_hash      TEXT NOT NULL
);
CREATE INDEX account_purge_receipts_account ON account_purge_receipts(account_id, at);
