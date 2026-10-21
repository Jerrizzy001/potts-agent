-- Local voice sessions. No raw audio or verification codes are persisted.
CREATE TABLE voice_sessions (
  id TEXT PRIMARY KEY,
  action_id TEXT UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('owner','outbound')),
  recipient TEXT NOT NULL,
  purpose TEXT NOT NULL,
  call_sid TEXT UNIQUE,
  created_ms INTEGER NOT NULL,
  ended_ms INTEGER,
  state TEXT NOT NULL,
  transcript TEXT NOT NULL DEFAULT '[]'
);
