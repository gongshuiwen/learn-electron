import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

// Append migrations; published entries must remain unchanged. v1 also adopts
// the original unversioned schema without replacing its tables or history.
const migrations = [
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id);
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    error TEXT, request_id TEXT NOT NULL, request_message TEXT NOT NULL,
    assistant_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    UNIQUE (conversation_id, request_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(conversation_id)
    WHERE status IN ('running', 'cancelling');`,
  `ALTER TABLE conversations ADD COLUMN connection_id TEXT;
  ALTER TABLE runs ADD COLUMN error_code TEXT;
  UPDATE conversations SET connection_id = 'env'
    WHERE EXISTS (SELECT 1 FROM messages WHERE conversation_id = conversations.id);`,
]

export function migrate(db: DatabaseSync, path: string): void {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
  if (version > migrations.length) throw new Error('数据库来自更新版本的应用，请升级后再打开')
  if (version === migrations.length) return

  if (
    path !== ':memory:' &&
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .get()
  ) {
    // SQLite copies committed WAL data too; copying only app.sqlite would not.
    db.prepare('VACUUM INTO ?').run(`${path}.before-v${migrations.length}.${randomUUID()}.bak`)
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    for (let index = version; index < migrations.length; index++) {
      db.exec(migrations[index]!)
      db.exec(`PRAGMA user_version = ${index + 1}`)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
