CREATE TABLE owner_reminders (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  channel TEXT NOT NULL,
  target TEXT NOT NULL,
  next_due_ms INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
