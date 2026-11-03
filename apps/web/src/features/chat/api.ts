import {
  API_PREFIX,
  isActiveRun,
  isRecord,
  parseRunEvent as parseContractRunEvent,
} from '@learn-electron/contracts'
import type { RunEvent } from '@learn-electron/contracts'
import { platform } from '@/platform'

const apiBase = `${platform.apiBaseUrl}${API_PREFIX}`

export class StreamProtocolError extends Error {}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  })
  if (!response.ok) {
    let message = `请求失败（${response.status}）`
    try {
      const body: unknown = await response.json()
      if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
        message = body.error.message
      }
    } catch {
      // Proxies can return an HTML error page rather than the API error envelope.
    }
    throw new Error(message)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export function parseRunEvent(data: string): RunEvent {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch (cause) {
    throw new StreamProtocolError('服务端事件不是有效 JSON，请刷新页面。', { cause })
  }
  try {
    return parseContractRunEvent(value)
  } catch (cause) {
    throw new StreamProtocolError(
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
  if (!response.ok) throw new Error('无法连接回复流。')
  if (!response.body || !response.headers.get('Content-Type')?.startsWith('text/event-stream')) {
    throw new StreamProtocolError('服务端回复流格式不兼容，请刷新页面。')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  let terminal = false
  let conversationId: string | undefined
  try {
    while (!signal.aborted && !terminal) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        if (line === '' && data.length) {
          const event = parseRunEvent(data.join('\n'))
          data = []
          if (
            event.runId !== runId ||
            (conversationId && event.conversationId !== conversationId) ||
            (!conversationId && event.type !== 'snapshot')
          ) {
            throw new StreamProtocolError('服务端回复流与当前任务不匹配，请刷新页面。')
          }
          conversationId = event.conversationId
          onEvent(event)
          terminal =
            (event.type === 'snapshot' && !isActiveRun(event.snapshot.run)) ||
            (event.type === 'run.updated' && !isActiveRun(event.run))
          if (terminal) break
        }
      }
      if (buffer.length > 1_048_576) throw new StreamProtocolError('回复流格式无效，请刷新页面。')
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
