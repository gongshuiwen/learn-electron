export const API_VERSION = 1 as const
export const API_PREFIX = '/api/v1'

export interface ServiceMeta {
  apiVersion: typeof API_VERSION
  engine: 'pi' | 'mock'
  model: { provider: string; id: string }
  configured: boolean
  capabilities: { tools: boolean }
}

export interface Conversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  status: 'streaming' | 'complete' | 'interrupted'
}

export type RunStatus =
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted'

export interface Run {
  id: string
  conversationId: string
  status: RunStatus
  createdAt: string
  updatedAt: string
  error?: string
}

export interface ConversationSnapshot {
  conversation: Conversation
  messages: Message[]
  run: Run | null
  sequence: number
}

interface EventBase {
  apiVersion: typeof API_VERSION
  conversationId: string
  runId: string
  sequence: number
}

export type RunEvent = EventBase &
  (
    | { type: 'snapshot'; snapshot: ConversationSnapshot }
    | { type: 'message.delta'; messageId: string; delta: string }
    | { type: 'message.completed'; message: Message }
    | { type: 'run.updated'; run: Run }
  )

export interface StartRunRequest {
  message: string
  requestId: string
}

export interface ApiError {
  error: { code: string; message: string }
}

export function isActiveRun(run: Run | null | undefined): boolean {
  return run?.status === 'running' || run?.status === 'cancelling'
}

export function parseStartRun(value: unknown): StartRunRequest {
  if (!isRecord(value)) throw new Error('请求必须是 JSON 对象')
  if (typeof value.message !== 'string' || !value.message.trim() || value.message.length > 32_000) {
    throw new Error('消息必须包含 1 至 32000 个字符')
  }
  if (typeof value.requestId !== 'string' || !/^[\w-]{8,128}$/.test(value.requestId)) {
    throw new Error('requestId 格式无效')
  }
  return { message: value.message.trim(), requestId: value.requestId }
}

export function parseTitle(value: unknown): string {
  if (!isRecord(value) || typeof value.title !== 'string') throw new Error('缺少会话标题')
  const title = value.title.trim()
  if (!title || title.length > 100) throw new Error('标题必须包含 1 至 100 个字符')
  return title
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConversation(value: unknown): value is Conversation {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.status === 'string' &&
    ['streaming', 'complete', 'interrupted'].includes(value.status)
  )
}

function isRun(value: unknown): value is Run {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.conversationId === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.status === 'string' &&
    ['running', 'cancelling', 'completed', 'cancelled', 'failed', 'interrupted'].includes(
      value.status,
    ) &&
    (value.error === undefined || typeof value.error === 'string')
  )
}

function isSnapshot(value: unknown): value is ConversationSnapshot {
  return (
    isRecord(value) &&
    isConversation(value.conversation) &&
    Array.isArray(value.messages) &&
    value.messages.every(isMessage) &&
    (value.run === null ||
      (isRun(value.run) && value.run.conversationId === value.conversation.id)) &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0
  )
}

export function parseServiceMeta(value: unknown): ServiceMeta {
  if (isRecord(value) && typeof value.apiVersion === 'number' && value.apiVersion !== API_VERSION) {
    throw new Error(`服务端 API 版本不兼容，需要 v${String(API_VERSION)}，请同步升级前后端。`)
  }
  if (
    !isRecord(value) ||
    value.apiVersion !== API_VERSION ||
    (value.engine !== 'pi' && value.engine !== 'mock') ||
    !isRecord(value.model) ||
    typeof value.model.provider !== 'string' ||
    typeof value.model.id !== 'string' ||
    typeof value.configured !== 'boolean' ||
    !isRecord(value.capabilities) ||
    typeof value.capabilities.tools !== 'boolean'
  ) {
    throw new Error('服务端元信息格式不兼容，请刷新页面。')
  }
  return {
    apiVersion: API_VERSION,
    engine: value.engine,
    model: { provider: value.model.provider, id: value.model.id },
    configured: value.configured,
    capabilities: { tools: value.capabilities.tools },
  }
}

export function parseConversation(value: unknown): Conversation {
  if (!isConversation(value)) throw new Error('服务端会话格式不兼容，请刷新页面。')
  return value
}

export function parseConversations(value: unknown): Conversation[] {
  if (!Array.isArray(value) || !value.every(isConversation)) {
    throw new Error('服务端会话列表格式不兼容，请刷新页面。')
  }
  return value
}

export function parseRun(value: unknown): Run {
  if (!isRun(value)) throw new Error('服务端任务格式不兼容，请刷新页面。')
  return value
}

export function parseConversationSnapshot(value: unknown): ConversationSnapshot {
  if (!isSnapshot(value)) throw new Error('服务端会话快照格式不兼容，请刷新页面。')
  return value
}

export function parseRunEvent(value: unknown): RunEvent {
  if (
    !isRecord(value) ||
    value.apiVersion !== API_VERSION ||
    typeof value.conversationId !== 'string' ||
    typeof value.runId !== 'string' ||
    typeof value.sequence !== 'number' ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0
  ) {
    throw new Error('服务端事件格式不兼容，请刷新页面。')
  }
  const base = {
    apiVersion: API_VERSION,
    conversationId: value.conversationId,
    runId: value.runId,
    sequence: value.sequence,
  }
  if (
    value.type === 'snapshot' &&
    isSnapshot(value.snapshot) &&
    value.snapshot.conversation.id === base.conversationId &&
    value.snapshot.sequence === base.sequence
  ) {
    // An old run's snapshot can contain the conversation's newer current run.
    return { ...base, type: 'snapshot', snapshot: value.snapshot }
  }
  if (
    value.type === 'message.delta' &&
    typeof value.messageId === 'string' &&
    typeof value.delta === 'string'
  ) {
    return { ...base, type: 'message.delta', messageId: value.messageId, delta: value.delta }
  }
  if (value.type === 'message.completed' && isMessage(value.message)) {
    return { ...base, type: 'message.completed', message: value.message }
  }
  if (
    value.type === 'run.updated' &&
    isRun(value.run) &&
    value.run.id === base.runId &&
    value.run.conversationId === base.conversationId
  ) {
    return { ...base, type: 'run.updated', run: value.run }
  }
  throw new Error('服务端事件内容不完整或不兼容，请刷新页面。')
}
