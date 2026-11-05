-- Historical schema before versioned migrations. Keep this fixture unchanged.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL
);
CREATE INDEX messages_conversation ON messages(conversation_id);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  error TEXT, request_id TEXT NOT NULL, request_message TEXT NOT NULL,
  assistant_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  UNIQUE (conversation_id, request_id)
);
CREATE UNIQUE INDEX one_active_run ON runs(conversation_id)
  WHERE status IN ('running', 'cancelling');

-- Flush the schema, then leave committed sample data in the WAL for the backup test.
PRAGMA wal_checkpoint(TRUNCATE);
PRAGMA wal_autocheckpoint = 0;
INSERT INTO conversations VALUES (
  'legacy-conversation', 'Saved conversation',
  '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 3
);
INSERT INTO messages VALUES
  ('legacy-user', 'legacy-conversation', 'user', 'saved question', '2026-01-01T00:00:00.000Z', 'complete'),
  ('legacy-assistant', 'legacy-conversation', 'assistant', 'saved answer', '2026-01-01T00:00:00.000Z', 'complete');
INSERT INTO runs VALUES (
  'legacy-run', 'legacy-conversation', 'completed',
  '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z',
  NULL, 'saved-request', 'saved question', 'legacy-assistant'
);
