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
import { initializeSchema } from './schema.ts'
import { parseModelRef, type ModelRef } from '@learn-electron/model-connections'

type Row = Record<string, unknown>

function conversation(row: Row): Conversation {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(typeof row.model_selection === 'string'
      ? { selection: parseModelRef(JSON.parse(row.model_selection)) }
      : {}),
    ...(typeof row.connection_id === 'string'
      ? {
          binding: {
            instanceId: row.connection_id,
            modelId: typeof row.model_id === 'string' ? row.model_id : null,
          },
        }
      : {}),
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
    ...(typeof row.error_code === 'string' ? { errorCode: row.error_code } : {}),
    ...(typeof row.model_instance_id === 'string' && typeof row.model_id === 'string'
      ? { target: { instanceId: row.model_instance_id, modelId: row.model_id } }
      : {}),
  }
}

export class Store {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA foreign_keys = ON')
      initializeSchema(this.db)
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

  create(selection: ModelRef | null = null): Conversation {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db
      .prepare(
        'INSERT INTO conversations (id, title, created_at, updated_at, model_selection) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, '新对话', now, now, selection ? JSON.stringify(selection) : null)
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

  selectModel(id: string, selection: ModelRef): void {
    this.transaction(() => {
      const snapshot = this.snapshot(id)
      if (snapshot.conversation.binding || snapshot.messages.length)
        throw new ChatError('connection_changed', '该会话已使用模型，请新建会话后切换')
      this.db
        .prepare('UPDATE conversations SET model_selection = ? WHERE id = ?')
        .run(JSON.stringify(selection), id)
      this.bump(id)
    })
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
    target?: ModelRef,
  ): {
    run: Run
    created: boolean
    assistantId: string
    history: Array<{ role: 'user' | 'assistant'; content: string }>
  } {
    const connectionId = target?.instanceId ?? 'env'
    return this.transaction(() => {
      const conversation = this.getConversation(id)
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
      if (
        !conversation.binding &&
        conversation.selection &&
        target &&
        (conversation.selection.instanceId !== target.instanceId ||
          conversation.selection.modelId !== target.modelId)
      )
        throw new ChatError('connection_changed', '会话模型已改变，请重试发送')
      if (
        target &&
        (!request.expectedTarget ||
          request.expectedTarget.instanceId !== target.instanceId ||
          request.expectedTarget.modelId !== target.modelId)
      )
        throw new ChatError('connection_changed', '会话模型已改变，请刷新后重试发送')
      const history = this.snapshot(id)
        .messages.filter((item) => item.status === 'complete')
        .map(({ role, content }) => ({ role, content }))
      const binding = this.db
        .prepare('SELECT connection_id FROM conversations WHERE id = ?')
        .get(id)?.connection_id
      if (binding && binding !== connectionId)
        throw new ChatError('connection_changed', '该会话已绑定其他供应商实例，请新建会话')
      const boundModel = this.db
        .prepare('SELECT model_id FROM conversations WHERE id = ?')
        .get(id)?.model_id
      if (boundModel && boundModel !== target?.modelId)
        throw new ChatError('connection_changed', '该会话已绑定其他模型，请新建会话')
      this.db
        .prepare(
          'UPDATE conversations SET connection_id = ?, model_id = ?, model_selection = COALESCE(model_selection, ?) WHERE id = ?',
        )
        .run(connectionId, target?.modelId ?? null, target ? JSON.stringify(target) : null, id)
      const now = new Date().toISOString()
      const runId = randomUUID()
      const assistantId = randomUUID()
      const insert = this.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)')
      insert.run(randomUUID(), id, 'user', request.message, now, 'complete')
      insert.run(assistantId, id, 'assistant', '', now, 'streaming')
      this.db
        .prepare(
          'INSERT INTO runs (id, conversation_id, status, created_at, updated_at, error, request_id, request_message, assistant_id, model_instance_id, model_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          runId,
          id,
          'running',
          now,
          now,
          null,
          request.requestId,
          request.message,
          assistantId,
          target?.instanceId ?? null,
          target?.modelId ?? null,
        )
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
    errorCode?: string,
  ): { message: Message; run: Run; messageSequence: number; runSequence: number } {
    return this.transaction(() => {
      const item = this.getRun(runId)
      this.db
        .prepare(`UPDATE messages SET content = COALESCE(?, content), status = ?
        WHERE id = (SELECT assistant_id FROM runs WHERE id = ?)`)
        .run(text ?? null, status === 'completed' ? 'complete' : 'interrupted', runId)
      this.db
        .prepare(
          'UPDATE runs SET status = ?, updated_at = ?, error = ?, error_code = ? WHERE id = ?',
        )
        .run(status, new Date().toISOString(), error ?? null, errorCode ?? null, runId)
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
