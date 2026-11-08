import {
  API_VERSION,
  isActiveRun,
  type Run,
  type RunEvent,
  type ServiceMeta,
  type StartRunRequest,
} from '@learn-electron/contracts'
import type { AgentEngine, EngineRunInput } from '@learn-electron/agent-runtime'
import { ChatError } from './errors.ts'
import type { Store } from './store.ts'
import { waitWithin } from './wait-within.ts'

interface ActiveRun {
  controller: AbortController
  promise: Promise<void>
}

interface RunObserver {
  event(event: RunEvent): void
  close(error?: Error): void
}

interface PendingFinalization {
  runId: string
  text: string | undefined
  status: Exclude<Run['status'], 'running' | 'cancelling'>
  error: string | undefined
}

const MAX_RESPONSE_CHARACTERS = 1_000_000

function eventBase(run: Run, sequence: number) {
  return { apiVersion: API_VERSION, conversationId: run.conversationId, runId: run.id, sequence }
}

export class ChatService {
  private readonly active = new Map<string, ActiveRun>()
  private readonly deleting = new Map<string, Promise<void>>()
  private readonly subscribers = new Map<string, Set<RunObserver>>()
  private readonly pendingFinalizations = new Map<string, PendingFinalization>()
  private closing = false
  private closed = false
  private closePromise: Promise<void> | undefined

  constructor(
    private readonly store: Store,
    private readonly engine: AgentEngine,
  ) {}

  private assertOpen(): void {
    if (this.closing) throw new ChatError('shutting_down', '服务正在停止')
  }

  private retryFinalization(conversationId: string): void {
    const result = this.pendingFinalizations.get(conversationId)
    if (!result) return
    try {
      this.commitFinalization(conversationId, result)
    } catch {
      throw new ChatError('storage_unavailable', '任务结果暂未保存，请稍后重试')
    }
  }

  async meta(): Promise<ServiceMeta> {
    this.assertOpen()
    return { ...(await this.engine.meta()), apiVersion: API_VERSION }
  }

  listConversations() {
    this.assertOpen()
    return this.store.list()
  }

  createConversation() {
    this.assertOpen()
    return this.store.create()
  }

  getConversation(id: string) {
    this.assertOpen()
    this.retryFinalization(id)
    return this.store.snapshot(id)
  }

  renameConversation(id: string, title: string) {
    this.assertOpen()
    return this.store.rename(id, title)
  }

  async deleteConversation(id: string): Promise<void> {
    this.assertOpen()
    this.retryFinalization(id)
    if (isActiveRun(this.store.snapshot(id).run) || this.deleting.has(id)) {
      throw new ChatError('conversation_busy', '请先停止当前任务，再删除会话')
    }
    const deletion = Promise.resolve()
      .then(() => this.engine.deleteConversation?.(id))
      .then(() => this.store.delete(id))
    this.deleting.set(id, deletion)
    try {
      await deletion
    } finally {
      this.deleting.delete(id)
    }
  }

  async startRun(id: string, request: StartRunRequest): Promise<Run> {
    this.assertOpen()
    this.retryFinalization(id)
    const existing = this.store.findRequest(id, request)
    if (existing) return existing
    if (!(await this.engine.meta()).configured)
      throw new ChatError('engine_not_configured', '请先在服务端配置模型与 API 密钥')
    this.assertOpen()
    this.retryFinalization(id)
    if (this.deleting.has(id)) throw new ChatError('conversation_busy', '该会话正在删除')
    const started = this.store.start(id, request)
    if (started.created) {
      const controller = new AbortController()
      const promise = this.execute(
        started.run,
        started.assistantId,
        request.message,
        started.history,
        controller,
      )
        .catch(() => {
          if (this.closed) return
          console.error('任务结束状态保存失败，等待重试', started.run.id)
          this.closeSubscribers(started.run.id, new Error('任务结束状态保存失败'))
        })
        .finally(() => this.active.delete(started.run.id))
      this.active.set(started.run.id, { controller, promise })
    }
    return started.run
  }

  getRun(id: string): Run {
    this.assertOpen()
    const run = this.store.getRun(id)
    if (!this.pendingFinalizations.has(run.conversationId)) return run
    this.retryFinalization(run.conversationId)
    return this.store.getRun(id)
  }

  cancelRun(id: string): Run {
    const task = this.active.get(id)
    try {
      const run = this.getRun(id)
      if (!isActiveRun(run) || !task) return run
      let cancelling = run
      if (run.status !== 'cancelling') {
        const result = this.store.setRunStatus(id, 'cancelling')
        cancelling = result.run
        this.publish({
          ...eventBase(cancelling, result.sequence),
          type: 'run.updated',
          run: cancelling,
        })
      }
      return cancelling
    } finally {
      // A storage outage must not prevent stopping a still-running model.
      task?.controller.abort()
    }
  }

  subscribe(id: string, observer: RunObserver) {
    const run = this.getRun(id)
    const snapshot = this.store.snapshot(run.conversationId)
    const active = isActiveRun(run)
    const clients = this.subscribers.get(id) ?? new Set<RunObserver>()
    if (active) {
      clients.add(observer)
      this.subscribers.set(id, clients)
    }
    return {
      snapshot: { ...eventBase(run, snapshot.sequence), type: 'snapshot' as const, snapshot },
      active,
      unsubscribe: () => {
        clients.delete(observer)
        if (!clients.size && this.subscribers.get(id) === clients) this.subscribers.delete(id)
      },
    }
  }

  private closeSubscribers(id: string, error?: Error): void {
    const clients = this.subscribers.get(id)
    this.subscribers.delete(id)
    for (const observer of clients ?? []) this.closeObserver(observer, error)
  }

  private closeObserver(observer: RunObserver, error?: Error): void {
    try {
      observer.close(error)
    } catch {
      console.error('聊天订阅关闭失败')
    }
  }

  private publish(event: RunEvent): void {
    const clients = this.subscribers.get(event.runId)
    for (const observer of clients ?? []) {
      try {
        observer.event(event)
      } catch {
        clients?.delete(observer)
        this.closeObserver(observer, new Error('聊天订阅处理失败'))
      }
    }
    if (!clients?.size && this.subscribers.get(event.runId) === clients)
      this.subscribers.delete(event.runId)
    if (event.type === 'run.updated' && !isActiveRun(event.run)) this.closeSubscribers(event.runId)
  }

  private finishRun(
    run: Run,
    text: string | undefined,
    status: Exclude<Run['status'], 'running' | 'cancelling'>,
    error?: string,
  ): void {
    const result = { runId: run.id, text, status, error }
    // Retain the actual outcome until it commits. Reconnecting or retrying a
    // request retries this write, never the model call or a replacement result.
    this.pendingFinalizations.set(run.conversationId, result)
    this.commitFinalization(run.conversationId, result)
  }

  private commitFinalization(conversationId: string, result: PendingFinalization): void {
    const finished = this.store.finalizeRun(result.runId, result.text, result.status, result.error)
    this.pendingFinalizations.delete(conversationId)
    this.publish({
      ...eventBase(finished.run, finished.messageSequence),
      type: 'message.completed',
      message: finished.message,
    })
    this.publish({
      ...eventBase(finished.run, finished.runSequence),
      type: 'run.updated',
      run: finished.run,
    })
  }

  private async execute(
    run: Run,
    assistantId: string,
    text: string,
    history: EngineRunInput['history'],
    controller: AbortController,
  ): Promise<void> {
    let receivedCharacters = 0
    let finalText: string | undefined
    let status: Run['status'] = 'completed'
    try {
      const result = await this.engine.run({
        conversationId: run.conversationId,
        message: text,
        history,
        signal: controller.signal,
        onDelta: (delta) => {
          if (this.closed || controller.signal.aborted) return
          receivedCharacters += delta.length
          if (receivedCharacters > MAX_RESPONSE_CHARACTERS) {
            controller.abort(new Error('模型回复超过长度限制'))
            return
          }
          const sequence = this.store.append(run.id, delta)
          this.publish({
            ...eventBase(run, sequence),
            type: 'message.delta',
            messageId: assistantId,
            delta,
          })
        },
      })
      finalText = result.text.slice(0, MAX_RESPONSE_CHARACTERS)
      if (controller.signal.aborted) status = this.closing ? 'interrupted' : 'cancelled'
    } catch {
      status = controller.signal.aborted ? (this.closing ? 'interrupted' : 'cancelled') : 'failed'
    }
    if (this.closed) return
    this.finishRun(
      run,
      status === 'completed' ? finalText : undefined,
      status,
      status === 'failed'
        ? '模型请求失败，请检查服务端配置或稍后重试'
        : status === 'interrupted'
          ? '服务已停止，任务没有自动重放'
          : undefined,
    )
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closing = true
      for (const task of this.active.values()) task.controller.abort()
      try {
        await waitWithin(
          Promise.allSettled([...this.active.values()].map((task) => task.promise)),
          3000,
        )
        // Native deletion cannot be cancelled; keep the store and lease alive
        // until it finishes, even when the client has already disconnected.
        await Promise.allSettled(this.deleting.values())
        for (const id of this.pendingFinalizations.keys()) {
          try {
            this.retryFinalization(id)
          } catch {
            // A failure in one conversation must not discard other results.
          }
        }
        if (this.pendingFinalizations.size)
          throw new ChatError('storage_unavailable', '任务结果暂未保存，请稍后重试')
        this.store.interruptActive()
      } finally {
        this.closed = true
        for (const id of this.subscribers.keys()) this.closeSubscribers(id)
      }
    })()
    return this.closePromise
  }
}
