import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isActiveRun,
  parseConversation,
  parseConversations,
  parseConversationSnapshot,
  parseRun,
  parseServiceMeta,
} from '@learn-electron/contracts'
import type {
  Conversation,
  ConversationSnapshot,
  RunEvent,
  ServiceMeta,
} from '@learn-electron/contracts'
import { readRunEvents, reconnectDelay } from './api'
import { ApiRequestError, ProtocolError, request } from '@/lib/api'

const selectionKey = 'learn-electron.chat.selection.v1'

function updateConversation(list: Conversation[], updated: Conversation): Conversation[] {
  return list
    .map((item) => (item.id === updated.id ? updated : item))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。'
}

function savedSelection(): string | null {
  try {
    return localStorage.getItem(selectionKey)
  } catch {
    return null
  }
}

function rememberSelection(id: string | null): void {
  try {
    if (id) localStorage.setItem(selectionKey, id)
    else localStorage.removeItem(selectionKey)
  } catch {
    // Conversations remain safely stored on the server when browser storage is disabled.
  }
}

function applyEvent(
  current: ConversationSnapshot | null,
  event: RunEvent,
): ConversationSnapshot | null {
  if (event.type === 'snapshot') return event.snapshot
  if (
    !current ||
    current.conversation.id !== event.conversationId ||
    event.sequence <= current.sequence
  )
    return current
  if (event.type === 'message.delta') {
    return {
      ...current,
      sequence: event.sequence,
      messages: current.messages.map((message) =>
        message.id === event.messageId
          ? { ...message, content: message.content + event.delta }
          : message,
      ),
    }
  }
  if (event.type === 'message.completed') {
    const exists = current.messages.some((message) => message.id === event.message.id)
    return {
      ...current,
      sequence: event.sequence,
      messages: exists
        ? current.messages.map((message) =>
            message.id === event.message.id ? event.message : message,
          )
        : [...current.messages, event.message],
    }
  }
  return { ...current, sequence: event.sequence, run: event.run }
}

export function useChat() {
  const [meta, setMeta] = useState<ServiceMeta | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connection, setConnection] = useState<'idle' | 'connected' | 'reconnecting'>('idle')
  const [reload, setReload] = useState(0)
  const [reconnect, setReconnect] = useState(0)
  const selectedRef = useRef<string | null>(null)
  const loadController = useRef<AbortController | null>(null)
  const alive = useRef(true)
  const submission = useRef<{ conversationId: string; message: string; requestId: string } | null>(
    null,
  )

  const refreshMeta = useCallback(async () => {
    const service = await request('/meta', parseServiceMeta)
    if (alive.current) setMeta(service)
  }, [])

  const selectConversation = useCallback((id: string | null) => {
    if (id === selectedRef.current) return
    submission.current = null
    selectedRef.current = id
    loadController.current?.abort()
    setSelectedId(id)
    setSnapshot(null)
    setError(null)
    setLoading(id !== null)
    rememberSelection(id)
  }, [])

  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    void Promise.all([
      request('/meta', parseServiceMeta, { signal: controller.signal }),
      request('/conversations', parseConversations, { signal: controller.signal }),
    ])
      .then(([service, list]) => {
        if (controller.signal.aborted) return
        setMeta(service)
        setConversations(list)
        const remembered = savedSelection()
        const next = list.find((item) => item.id === remembered)?.id ?? list[0]?.id ?? null
        selectConversation(next)
        if (!next) setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setMeta(null)
          setError(errorMessage(cause))
          setLoading(false)
        }
      })
    return () => {
      alive.current = false
      controller.abort()
    }
  }, [reload, selectConversation])

  useEffect(() => {
    if (!selectedId) return
    const controller = new AbortController()
    loadController.current = controller
    void request(`/conversations/${encodeURIComponent(selectedId)}`, parseConversationSnapshot, {
      signal: controller.signal,
    })
      .then((detail) => {
        if (!controller.signal.aborted) {
          setSnapshot(detail)
          setLoading(false)
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(cause))
          setLoading(false)
        }
      })
    return () => controller.abort()
  }, [selectedId, reload])

  const runId = snapshot?.run?.id
  const active = isActiveRun(snapshot?.run)
  useEffect(() => {
    if (!runId || !active || !selectedId) return
    const controller = new AbortController()
    const id = selectedId
    const currentRunId = runId
    async function listen(): Promise<void> {
      let retries = 0
      while (!controller.signal.aborted) {
        try {
          const terminal = await readRunEvents(currentRunId, controller.signal, (event) => {
            if (controller.signal.aborted || event.conversationId !== id || event.runId !== runId)
              return
            setConnection('connected')
            setSnapshot((current) => applyEvent(current, event))
          })
          if (terminal) {
            setConnection('idle')
            return
          }
        } catch (cause) {
          if (controller.signal.aborted) return
          if (
            cause instanceof ProtocolError ||
            (cause instanceof ApiRequestError && !cause.retryable)
          ) {
            setConnection('idle')
            setError(cause.message)
            return
          }
        }
        if (controller.signal.aborted) return
        setConnection('reconnecting')
        await reconnectDelay(controller.signal, Math.min(500 * 2 ** retries++, 5000))
      }
    }
    void listen()
    return () => controller.abort()
  }, [runId, active, selectedId, reconnect])

  async function createConversation(): Promise<void> {
    setPending(true)
    setError(null)
    try {
      const conversation = await request('/conversations', parseConversation, {
        method: 'POST',
        body: '{}',
      })
      if (!alive.current) return
      setConversations((list) => [conversation, ...list])
      selectConversation(conversation.id)
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause))
    } finally {
      if (alive.current) setPending(false)
    }
  }

  async function send(message: string): Promise<boolean> {
    const text = message.trim()
    if (!text || active || pending || !meta?.configured) return false
    setPending(true)
    setError(null)
    let id = selectedRef.current
    try {
      if (!id) {
        const conversation = await request('/conversations', parseConversation, {
          method: 'POST',
          body: '{}',
        })
        if (!alive.current) return false
        id = conversation.id
        setConversations((list) => [conversation, ...list])
        selectConversation(id)
      }
      // A POST can succeed even when its response or the following GET is lost.
      // Retrying the same submission must resolve the existing server run.
      const attempt =
        submission.current?.conversationId === id && submission.current.message === text
          ? submission.current
          : { conversationId: id, message: text, requestId: crypto.randomUUID() }
      submission.current = attempt
      const run = await request(`/conversations/${encodeURIComponent(id)}/runs`, parseRun, {
        method: 'POST',
        body: JSON.stringify({ message: text, requestId: attempt.requestId }),
      })
      const detail = await request(
        `/conversations/${encodeURIComponent(id)}`,
        parseConversationSnapshot,
      )
      if (submission.current === attempt) submission.current = null
      if (!alive.current) return true
      if (selectedRef.current === id) {
        loadController.current?.abort()
        setSnapshot({ ...detail, run: detail.run ?? run })
        setLoading(false)
      }
      setConversations((list) => updateConversation(list, detail.conversation))
      return true
    } catch (cause) {
      if (alive.current) {
        setError(errorMessage(cause))
        setLoading(false)
      }
      return false
    } finally {
      if (alive.current) setPending(false)
    }
  }

  async function cancel(): Promise<void> {
    if (!runId || !active) return
    setPending(true)
    try {
      const run = await request(`/runs/${encodeURIComponent(runId)}/cancel`, parseRun, {
        method: 'POST',
      })
      const detail = await request(
        `/conversations/${encodeURIComponent(run.conversationId)}`,
        parseConversationSnapshot,
      )
      if (alive.current && selectedRef.current === run.conversationId) setSnapshot(detail)
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause))
    } finally {
      if (alive.current) setPending(false)
    }
  }

  async function rename(title: string): Promise<boolean> {
    const id = selectedRef.current
    if (!id || !title.trim()) return false
    setPending(true)
    try {
      const conversation = await request(
        `/conversations/${encodeURIComponent(id)}`,
        parseConversation,
        { method: 'PATCH', body: JSON.stringify({ title }) },
      )
      if (!alive.current) return true
      setConversations((list) => updateConversation(list, conversation))
      setSnapshot((current) =>
        current?.conversation.id === id ? { ...current, conversation } : current,
      )
      return true
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause))
      return false
    } finally {
      if (alive.current) setPending(false)
    }
  }

  async function remove(): Promise<boolean> {
    const id = selectedRef.current
    if (!id) return false
    setPending(true)
    try {
      await request(`/conversations/${encodeURIComponent(id)}`, undefined, { method: 'DELETE' })
      if (!alive.current) return true
      const remaining = conversations.filter((item) => item.id !== id)
      setConversations(remaining)
      if (selectedRef.current === id) selectConversation(remaining[0]?.id ?? null)
      return true
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause))
      return false
    } finally {
      if (alive.current) setPending(false)
    }
  }

  return {
    meta,
    conversations,
    selectedId,
    snapshot,
    loading,
    pending,
    active,
    error,
    connection,
    selectConversation,
    createConversation,
    send,
    cancel,
    rename,
    remove,
    retry: () => {
      setError(null)
      // Stop the old stream; loading its snapshot will subscribe to the current run again.
      setSnapshot(null)
      setLoading(true)
      setReload((value) => value + 1)
    },
    reconnect: () => setReconnect((value) => value + 1),
    refreshMeta,
  }
}
