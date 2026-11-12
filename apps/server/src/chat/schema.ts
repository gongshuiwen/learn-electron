import type { DatabaseSync } from 'node:sqlite'

const version = 4

export function initializeSchema(db: DatabaseSync): void {
  const current = Number(db.prepare('PRAGMA user_version').get()?.user_version)
  if (current === version) return
  if (current > version) throw new Error('数据库来自更新版本的应用，请升级后再打开')
  if (
    current !== 0 ||
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()
  )
    throw new Error('数据库版本不受支持，请使用新的数据目录')

  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0,
        connection_id TEXT, model_id TEXT, model_selection TEXT
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
        error_code TEXT, model_instance_id TEXT, model_id TEXT,
        UNIQUE (conversation_id, request_id)
      );
      CREATE UNIQUE INDEX one_active_run ON runs(conversation_id)
        WHERE status IN ('running', 'cancelling');
      PRAGMA user_version = ${version};
    `)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
