import { parseModelRef, parseModelStatus } from './models.ts'
import { API_VERSION } from './generated/http.ts'
import { isSchema, parseSchema } from './validation.ts'
import type {
  Conversation,
  ConversationSnapshot,
  Run,
  RunEvent,
  ServiceMeta,
  StartRunRequest,
  ApiError,
} from './generated/types.ts'

export { API_VERSION, API_PREFIX } from './generated/http.ts'
export type {
  ApiError,
  Conversation,
  ConversationSnapshot,
  Message,
  Run,
  RunEvent,
  RunStatus,
  ServiceMeta,
  StartRunRequest,
} from './generated/types.ts'

export function isActiveRun(run: Run | null | undefined): boolean {
  return run?.status === 'running' || run?.status === 'cancelling'
}

export function parseStartRun(value: unknown): StartRunRequest {
  const body = parseSchema('StartRunRequest', value, '消息或 requestId 格式无效')
  return {
    message: body.message.trim(),
    requestId: body.requestId,
    ...(body.expectedTarget === undefined
      ? {}
      : { expectedTarget: parseModelRef(body.expectedTarget) }),
  }
}

export function parseTitle(value: unknown): string {
  return parseSchema('RenameConversationRequest', value, '会话标题格式无效').title.trim()
}

export function parseServiceMeta(value: unknown): ServiceMeta {
  if (isSchema('ServiceVersionInfo', value) && value.apiVersion !== API_VERSION) {
    throw new Error(`服务端 API 版本不兼容，需要 v${String(API_VERSION)}，请同步升级前后端。`)
  }
  const meta = parseSchema('ServiceMeta', value, '服务端元信息格式不兼容，请刷新页面。')
  return {
    ...parseModelStatus(meta),
    apiVersion: API_VERSION,
    engine: meta.engine,
    capabilities: { tools: meta.capabilities.tools },
  }
}

export function parseApiError(value: unknown): ApiError {
  return parseSchema('ApiError', value, '服务端错误响应格式不兼容。')
}

export function parseConversation(value: unknown): Conversation {
  return parseSchema('Conversation', value, '服务端会话格式不兼容，请刷新页面。')
}

export function parseConversations(value: unknown): Conversation[] {
  return parseSchema('Conversations', value, '服务端会话列表格式不兼容，请刷新页面。')
}

export function parseRun(value: unknown): Run {
  return parseSchema('Run', value, '服务端任务格式不兼容，请刷新页面。')
}

function checkSnapshotIdentity(snapshot: ConversationSnapshot): void {
  if (snapshot.run && snapshot.run.conversationId !== snapshot.conversation.id) {
    throw new Error('服务端会话快照格式不兼容，请刷新页面。')
  }
}

export function parseConversationSnapshot(value: unknown): ConversationSnapshot {
  const snapshot = parseSchema(
    'ConversationSnapshot',
    value,
    '服务端会话快照格式不兼容，请刷新页面。',
  )
  checkSnapshotIdentity(snapshot)
  return snapshot
}

export function parseRunEvent(value: unknown): RunEvent {
  const event = parseSchema('RunEvent', value, '服务端事件格式不兼容，请刷新页面。')
  const base = {
    apiVersion: event.apiVersion,
    conversationId: event.conversationId,
    runId: event.runId,
    sequence: event.sequence,
  }
  if (event.type === 'snapshot') {
    checkSnapshotIdentity(event.snapshot)
    if (
      event.snapshot.conversation.id !== event.conversationId ||
      event.snapshot.sequence !== event.sequence
    )
      throw new Error('服务端事件内容不完整或不兼容，请刷新页面。')
    // An old run's snapshot can contain the conversation's newer current run.
    return { ...base, type: 'snapshot', snapshot: event.snapshot }
  }
  if (event.type === 'message.delta')
    return { ...base, type: 'message.delta', messageId: event.messageId, delta: event.delta }
  if (event.type === 'message.completed')
    return { ...base, type: 'message.completed', message: event.message }
  if (event.run.id !== event.runId || event.run.conversationId !== event.conversationId)
    throw new Error('服务端事件内容不完整或不兼容，请刷新页面。')
  return { ...base, type: 'run.updated', run: event.run }
}
