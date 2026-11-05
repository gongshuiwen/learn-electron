import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  Conversation,
  ConversationSnapshot,
  Message,
  Run,
  RunStatus,
  StartRunRequest,
} from '@learn-electron/contracts'
import { ChatError } from './errors.ts'
import { migrate } from './migrations.ts'

type Row = Record<string, unknown>

function conversation(row: Row): Conversation {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function message(row: Row): Message {
  return {
    id: String(row.id),
    role: row.role as Message['role'],
    content: String(row.content),
    createdAt: String(row.created_at),
    status: row.status as Message['status'],
  }
}

function run(row: Row): Run {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    status: row.status as RunStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
  }
}

export class Store {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA foreign_keys = ON')
      migrate(this.db, path)
      this.db.exec('PRAGMA journal_mode = WAL')
      this.interruptActive()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  list(): Conversation[] {
    return this.db
      .prepare('SELECT * FROM conversations ORDER BY updated_at DESC, rowid DESC')
      .all()
      .map(conversation)
  }

  create(): Conversation {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db
      .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, '新对话', now, now)
    return this.getConversation(id)
  }

  getConversation(id: string): Conversation {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id)
    if (!row) throw new ChatError('conversation_not_found', '会话不存在')
    return conversation(row)
  }

  snapshot(id: string): ConversationSnapshot {
    const item = this.getConversation(id)
    const sequence = this.db.prepare('SELECT sequence FROM conversations WHERE id = ?').get(id)
    const latest = this.db
      .prepare('SELECT * FROM runs WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(id)
    return {
      conversation: item,
      messages: this.db
        .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid')
        .all(id)
        .map(message),
      run: latest ? run(latest) : null,
      sequence: Number(sequence?.sequence ?? 0),
    }
  }

  rename(id: string, title: string): Conversation {
    this.getConversation(id)
    this.db
      .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, new Date().toISOString(), id)
    return this.getConversation(id)
  }

  delete(id: string): void {
    this.getConversation(id)
    if (
      this.db
        .prepare(
          "SELECT id FROM runs WHERE conversation_id = ? AND status IN ('running', 'cancelling')",
        )
        .get(id)
    ) {
      throw new ChatError('conversation_busy', '请先停止当前任务，再删除会话')
    }
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  getRun(id: string): Run {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id)
    if (!row) throw new ChatError('run_not_found', '任务不存在')
    return run(row)
  }

  private requestRow(id: string, request: StartRunRequest): Row | undefined {
    const existing = this.db
      .prepare('SELECT * FROM runs WHERE conversation_id = ? AND request_id = ?')
      .get(id, request.requestId)
    if (existing && existing.request_message !== request.message) {
      throw new ChatError('idempotency_conflict', '该 requestId 已用于其他消息')
    }
    return existing
  }

  findRequest(id: string, request: StartRunRequest): Run | null {
    this.getConversation(id)
    const existing = this.requestRow(id, request)
    return existing ? run(existing) : null
  }

  start(
    id: string,
    request: StartRunRequest,
  ): {
    run: Run
    created: boolean
    assistantId: string
    history: Array<{ role: 'user' | 'assistant'; content: string }>
  } {
    return this.transaction(() => {
      this.getConversation(id)
      const existing = this.requestRow(id, request)
      if (existing) {
        return {
          run: run(existing),
          created: false,
          assistantId: String(existing.assistant_id),
          history: [],
        }
      }
      if (
        this.db
          .prepare(
            "SELECT id FROM runs WHERE conversation_id = ? AND status IN ('running', 'cancelling')",
          )
          .get(id)
      ) {
        throw new ChatError('conversation_busy', '该会话已有任务正在运行')
      }
      const history = this.snapshot(id)
        .messages.filter((item) => item.status === 'complete')
        .map(({ role, content }) => ({ role, content }))
      const now = new Date().toISOString()
      const runId = randomUUID()
      const assistantId = randomUUID()
      const insert = this.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)')
      insert.run(randomUUID(), id, 'user', request.message, now, 'complete')
      insert.run(assistantId, id, 'assistant', '', now, 'streaming')
      this.db
        .prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(runId, id, 'running', now, now, null, request.requestId, request.message, assistantId)
      this.bump(id)
      return { run: this.getRun(runId), created: true, assistantId, history }
    })
  }

  append(runId: string, delta: string): number {
    return this.transaction(() => {
      const item = this.getRun(runId)
      this.db
        .prepare(
          'UPDATE messages SET content = content || ? WHERE id = (SELECT assistant_id FROM runs WHERE id = ?)',
        )
        .run(delta, runId)
      return this.bump(item.conversationId)
    })
  }

  setRunStatus(id: string, status: RunStatus, error?: string): { run: Run; sequence: number } {
    return this.transaction(() => {
      const item = this.getRun(id)
      this.db
        .prepare('UPDATE runs SET status = ?, updated_at = ?, error = ? WHERE id = ?')
        .run(status, new Date().toISOString(), error ?? null, id)
      return { run: this.getRun(id), sequence: this.bump(item.conversationId) }
    })
  }

  finalizeRun(
    runId: string,
    text: string | undefined,
    status: Exclude<RunStatus, 'running' | 'cancelling'>,
    error?: string,
  ): { message: Message; run: Run; messageSequence: number; runSequence: number } {
    return this.transaction(() => {
      const item = this.getRun(runId)
      this.db
        .prepare(`UPDATE messages SET content = COALESCE(?, content), status = ?
        WHERE id = (SELECT assistant_id FROM runs WHERE id = ?)`)
        .run(text ?? null, status === 'completed' ? 'complete' : 'interrupted', runId)
      this.db
        .prepare('UPDATE runs SET status = ?, updated_at = ?, error = ? WHERE id = ?')
        .run(status, new Date().toISOString(), error ?? null, runId)
      const row = this.db
        .prepare('SELECT * FROM messages WHERE id = (SELECT assistant_id FROM runs WHERE id = ?)')
        .get(runId)
      if (!row) throw new Error('Missing assistant message')
      const messageSequence = this.bump(item.conversationId)
      const runSequence = this.bump(item.conversationId)
      return { message: message(row), run: this.getRun(runId), messageSequence, runSequence }
    })
  }

  private bump(id: string): number {
    this.db
      .prepare('UPDATE conversations SET sequence = sequence + 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id)
    const row = this.db.prepare('SELECT sequence FROM conversations WHERE id = ?').get(id)
    return Number(row?.sequence ?? 0)
  }

  interruptActive(): void {
    this.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM runs WHERE status IN ('running', 'cancelling')")
        .all()
      for (const row of rows) {
        const item = run(row)
        this.db
          .prepare("UPDATE runs SET status = 'interrupted', updated_at = ?, error = ? WHERE id = ?")
          .run(new Date().toISOString(), '服务已停止，任务没有自动重放', item.id)
        this.db
          .prepare("UPDATE messages SET status = 'interrupted' WHERE id = ?")
          .run(String(row.assistant_id))
        this.bump(item.conversationId)
      }
    })
  }

  close(): void {
    this.db.close()
  }
}
