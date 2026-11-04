import {
  API_PREFIX,
  isActiveRun,
  isRecord,
  parseRunEvent as parseContractRunEvent,
} from '@learn-electron/contracts'
import type { RunEvent } from '@learn-electron/contracts'
import { platform } from '@/platform'

const apiBase = `${platform.apiBaseUrl}${API_PREFIX}`

export class ProtocolError extends Error {}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
  }

  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500
  }
}

async function readRequestError(response: Response): Promise<ApiRequestError> {
  let message = `请求失败（${response.status}）`
  let code: string | undefined
  try {
    const body: unknown = await response.json()
    if (isRecord(body) && isRecord(body.error)) {
      if (typeof body.error.message === 'string') message = body.error.message
      if (typeof body.error.code === 'string') code = body.error.code
    }
  } catch {
    // Proxies can return an HTML error page rather than the API error envelope.
  }
  return new ApiRequestError(response.status, code, message)
}

export function request(path: string, decode: undefined, init?: RequestInit): Promise<void>
export function request<T>(
  path: string,
  decode: (value: unknown) => T,
  init?: RequestInit,
): Promise<T>
export async function request<T>(
  path: string,
  decode: ((value: unknown) => T) | undefined,
  init: RequestInit = {},
): Promise<T | void> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  })
  if (!response.ok) throw await readRequestError(response)
  if (!decode) {
    if (response.status !== 204) throw new ProtocolError('服务端响应格式不兼容，请刷新页面。')
    return
  }
  try {
    const value: unknown = await response.json()
    return decode(value)
  } catch (cause) {
    if (init.signal?.aborted) throw cause
    throw new ProtocolError(
      cause instanceof SyntaxError
        ? '服务端响应不是有效 JSON，请刷新页面。'
        : cause instanceof Error
          ? cause.message
          : '服务端响应格式不兼容，请刷新页面。',
      { cause },
    )
  }
}

export function parseRunEvent(data: string): RunEvent {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch (cause) {
    throw new ProtocolError('服务端事件不是有效 JSON，请刷新页面。', { cause })
  }
  try {
    return parseContractRunEvent(value)
  } catch (cause) {
    throw new ProtocolError(
      cause instanceof Error ? cause.message : '服务端事件格式不兼容，请刷新页面。',
      { cause },
    )
  }
}

// Every connection starts with an authoritative snapshot, so reconnects need no delta replay.
export async function readRunEvents(
  runId: string,
  signal: AbortSignal,
  onEvent: (event: RunEvent) => void,
): Promise<boolean> {
  const response = await fetch(`${apiBase}/runs/${encodeURIComponent(runId)}/events`, {
    signal,
    headers: { Accept: 'text/event-stream' },
  })
  if (!response.ok) throw await readRequestError(response)
  if (!response.body || !response.headers.get('Content-Type')?.startsWith('text/event-stream')) {
    throw new ProtocolError('服务端回复流格式不兼容，请刷新页面。')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const lineParts: string[] = []
  let data: string[] = []
  let terminal = false
  let conversationId: string | undefined
  try {
    while (!signal.aborted && !terminal) {
      const chunk = await reader.read()
      if (chunk.done) break
      // Full-history snapshots have no fixed frame limit. Join a long line once,
      // rather than copying it again for every network chunk.
      const text = decoder.decode(chunk.value, { stream: true })
      let start = 0
      let newline: number
      while ((newline = text.indexOf('\n', start)) !== -1) {
        lineParts.push(text.slice(start, newline))
        const line = lineParts.join('').replace(/\r$/, '')
        lineParts.length = 0
        start = newline + 1
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        if (line === '' && data.length) {
          const event = parseRunEvent(data.join('\n'))
          data = []
          if (
            event.runId !== runId ||
            (conversationId && event.conversationId !== conversationId) ||
            (!conversationId && event.type !== 'snapshot')
          ) {
            throw new ProtocolError('服务端回复流与当前任务不匹配，请刷新页面。')
          }
          conversationId = event.conversationId
          onEvent(event)
          terminal =
            (event.type === 'snapshot' && !isActiveRun(event.snapshot.run)) ||
            (event.type === 'run.updated' && !isActiveRun(event.run))
          if (terminal) break
        }
      }
      if (!terminal && start < text.length) lineParts.push(text.slice(start))
    }
    return terminal
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export function reconnectDelay(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}
