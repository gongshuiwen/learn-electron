import { modelRef, type ModelTarget, type ModelRef } from '@learn-electron/model-connections'
import type { ModelStatus } from '@learn-electron/contracts/models'
import type { ModelService } from '../models/index.ts'
import {
  API_VERSION,
  isActiveRun,
  type Run,
  type Conversation,
  type RunEvent,
  type ServiceMeta,
  type StartRunRequest,
} from '@learn-electron/contracts'
import type { AgentEngine, EngineRunInput } from '@learn-electron/agent-runtime'
import { ModelError } from '@learn-electron/agent-runtime'
import { waitWithin } from '../shared/index.ts'
import { ChatError } from './errors.ts'
import type { Store } from './store.ts'

interface ActiveRun {
  controller: AbortController
  promise: Promise<void>
  instanceId?: string
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
  errorCode: string | undefined
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
    private readonly models?: ModelService,
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
    const info = await this.engine.meta()
    const status = this.models
      ? this.models.statusFor(this.models.defaultSelection())
      : { model: info.model, configured: info.configured, selection: null, target: null }
    return {
      ...status,
      engine: info.engine,
      capabilities: info.capabilities,
      apiVersion: API_VERSION,
    }
  }

  private async conversationStatus(conversation: Conversation): Promise<ModelStatus> {
    if (!this.models) {
      const info = await this.engine.meta()
      return { model: info.model, configured: info.configured, selection: null, target: null }
    }
    const selection = conversation.selection ?? this.models.defaultSelection()
    if (!conversation.binding) return this.models.statusFor(selection)
    const binding = conversation.binding
    const unavailable = (reason: string): ModelStatus => ({
      selection,
      target: null,
      model: { provider: 'unavailable', id: binding.modelId ?? 'unknown' },
      configured: false,
      reason,
    })
    if (binding.instanceId === 'env' || !binding.modelId) return unavailable('context_unavailable')
    const target = { instanceId: binding.instanceId, modelId: binding.modelId }
    return this.models.statusFor(conversation.selection ?? target, target)
  }

  listConversations() {
    this.assertOpen()
    return this.store.list()
  }

  createConversation(selection?: ModelRef) {
    this.assertOpen()
    return this.store.create(selection ?? this.models?.defaultSelection() ?? null)
  }

  async getConversation(id: string) {
    this.assertOpen()
    this.retryFinalization(id)
    const snapshot = this.store.snapshot(id)
    const model = await this.conversationStatus(snapshot.conversation)
    return { ...snapshot, model }
  }

  renameConversation(id: string, title: string) {
    this.assertOpen()
    return this.store.rename(id, title)
  }

  selectConversationModel(id: string, selection: ModelRef) {
    this.assertOpen()
    if (!this.models) throw new ChatError('engine_not_configured', '当前引擎不支持模型选择')
    if (this.deleting.has(id)) throw new ChatError('conversation_busy', '该会话正在删除')
    this.models.resolve(selection)
    this.store.selectModel(id, selection)
    return this.getConversation(id)
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
    const status = await this.conversationStatus(this.store.getConversation(id))
    if (!status.configured) {
      if (status.reason === 'context_unavailable')
        throw new ChatError(
          'connection_changed',
          '此会话没有可用的模型绑定，请新建会话；历史仍可查看',
        )
      throw new ChatError('engine_not_configured', '会话模型不可用，请检查实例凭据和模型配置')
    }
    const target = this.models && status.target ? this.models.resolve(status.target) : undefined
    this.assertOpen()
    this.retryFinalization(id)
    if (this.deleting.has(id)) throw new ChatError('conversation_busy', '该会话正在删除')
    const started = this.store.start(id, request, target ? modelRef(target) : undefined)
    if (started.created) {
      const controller = new AbortController()
      const promise = this.execute(
        started.run,
        started.assistantId,
        request.message,
        started.history,
        controller,
        target,
      )
        .catch(() => {
          if (this.closed) return
          console.error('任务结束状态保存失败，等待重试', started.run.id)
          this.closeSubscribers(started.run.id, new Error('任务结束状态保存失败'))
        })
        .finally(() => this.active.delete(started.run.id))
      this.active.set(started.run.id, {
        controller,
        promise,
        ...(target ? { instanceId: target.instanceId } : {}),
      })
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

  isBusy(instanceId?: string): boolean {
    return instanceId
      ? [...this.active.values()].some((task) => task.instanceId === instanceId)
      : this.active.size > 0 || this.deleting.size > 0
  }

  async cancelAll(instanceId?: string): Promise<void> {
    const tasks = [...this.active].filter(
      ([, task]) => !instanceId || task.instanceId === instanceId,
    )
    for (const [id, task] of tasks) {
      try {
        this.cancelRun(id)
      } finally {
        task.controller.abort()
      }
    }
    if (!(await waitWithin(Promise.allSettled(tasks.map(([, task]) => task.promise)), 3000)))
      throw new ChatError('conversation_busy', '任务仍在停止中，请稍后再退出登录')
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

  async subscribe(id: string, observer: RunObserver) {
    const initial = this.getRun(id)
    const info = await this.getConversation(initial.conversationId)
    // No await between the final snapshot and subscription: terminal events cannot be missed.
    const run = this.getRun(id)
    const snapshot = { ...this.store.snapshot(run.conversationId), model: info.model }
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
    errorCode?: string,
  ): void {
    const result = { runId: run.id, text, status, error, errorCode }
    // Retain the actual outcome until it commits. Reconnecting or retrying a
    // request retries this write, never the model call or a replacement result.
    this.pendingFinalizations.set(run.conversationId, result)
    this.commitFinalization(run.conversationId, result)
  }

  private commitFinalization(conversationId: string, result: PendingFinalization): void {
    const finished = this.store.finalizeRun(
      result.runId,
      result.text,
      result.status,
      result.error,
      result.errorCode,
    )
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
    target?: ModelTarget,
  ): Promise<void> {
    let receivedCharacters = 0
    let finalText: string | undefined
    let status: Run['status'] = 'completed'
    let failure: ModelError | undefined
    try {
      const result = await this.engine.run({
        conversationId: run.conversationId,
        message: text,
        history,
        ...(target ? { target } : {}),
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
    } catch (error) {
      if (error instanceof ModelError) failure = error
      status = controller.signal.aborted ? (this.closing ? 'interrupted' : 'cancelled') : 'failed'
    }
    if (this.closed) return
    this.finishRun(
      run,
      status === 'completed' ? finalText : undefined,
      status,
      status === 'failed'
        ? (failure?.message ?? '模型请求失败，请检查模型连接或稍后重试')
        : status === 'interrupted'
          ? '服务已停止，任务没有自动重放'
          : undefined,
      status === 'failed' ? failure?.code : undefined,
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
