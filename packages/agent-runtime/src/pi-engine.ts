import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { EnvHttpProxyAgent, setGlobalDispatcher, type Dispatcher } from 'undici8'
import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent'
import type { AgentEngine, EngineInfo, PiEngineOptions } from './index.ts'
import { ModelError, type ModelErrorCode } from './index.ts'
import type { ModelTarget } from '@learn-electron/model-connections'
import { createModelRuntime, modelFailure } from './pi-models.ts'

// The SDK imports Undici 8, replacing Node's environment-proxy dispatcher.
// Reapply proxy policy after SDK imports. Enforce redirects at the dispatcher,
// including SDKs that do not accept a caller-supplied fetch (Google GenAI).
const rejectRedirects: Dispatcher.DispatchInterceptor = (dispatch) => (options, handler) =>
  dispatch(options, {
    onRequestStart: (...args) => handler.onRequestStart?.(...args),
    onRequestUpgrade: (...args) => handler.onRequestUpgrade?.(...args),
    onResponseStart(controller, status, headers, statusMessage) {
      if ([301, 302, 303, 307, 308].includes(status)) {
        controller.abort(new Error('Model service redirects are disabled'))
        return
      }
      handler.onResponseStart?.(controller, status, headers, statusMessage)
    },
    onResponseData: (...args) => handler.onResponseData?.(...args),
    onResponseEnd: (...args) => handler.onResponseEnd?.(...args),
    onResponseError: (...args) => handler.onResponseError?.(...args),
    onResponseStarted: () => handler.onResponseStarted?.(),
    onBodySent: (...args) => handler.onBodySent?.(...args),
    onRequestSent: () => handler.onRequestSent?.(),
  })
setGlobalDispatcher(new EnvHttpProxyAgent().compose(rejectRedirects))

const SYSTEM_PROMPT =
  'You are a helpful assistant in a desktop and web chat application. ' +
  'Answer clearly in the language used by the user. ' +
  'You have no tools, filesystem access, browser access, or ability to execute commands. ' +
  'Do not claim to have performed actions outside this conversation.'

function createResources(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => SYSTEM_PROMPT,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: () => Promise.resolve(),
  }
}

export async function createPiEngine(options: PiEngineOptions): Promise<AgentEngine> {
  const agentDir = resolve(options.dataDir)
  const cwd = join(agentDir, 'workspace')
  const sessionsDir = join(agentDir, 'sessions')
  await mkdir(cwd, { recursive: true })
  await mkdir(sessionsDir, { recursive: true })

  const credentials = options.credentials
  const cached = new Map<string, { key: string; value: ReturnType<typeof createModelRuntime> }>()
  function modelRuntime(target: ModelTarget) {
    const key = `${target.revision}:${target.model.id}`
    let entry = cached.get(target.instanceId)
    if (entry?.key !== key) {
      if (!credentials) throw new ModelError('auth_required')
      entry = { key, value: createModelRuntime(target, credentials) }
      cached.set(target.instanceId, entry)
    }
    return entry.value
  }
  const active = new Map<string, AgentSession>()
  const shutdown = new AbortController()
  let closed = false

  return {
    meta() {
      return Promise.resolve<EngineInfo>({
        engine: 'pi',
        model: { provider: 'unconfigured', id: 'unconfigured' },
        configured: false,
        capabilities: { tools: false },
      })
    },
    async testConnection(target, signal) {
      if (closed) throw new Error('模型服务已关闭')
      const { runtime, model } = await modelRuntime(target)
      if (closed) throw new Error('模型服务已关闭')
      try {
        const result = await runtime.completeSimple(
          model,
          { messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }] },
          {
            signal: AbortSignal.any([signal, shutdown.signal]),
            maxTokens: Math.min(32, model.maxTokens),
          },
        )
        if (result.stopReason === 'error' || result.stopReason === 'aborted')
          throw new ModelError(modelFailure(result.errorMessage ?? ''))
      } catch (error) {
        if (
          error instanceof ModelError &&
          target.kind === 'chatgpt' &&
          !signal.aborted &&
          !shutdown.signal.aborted
        )
          await credentials?.failed(target, error.code)
        throw error instanceof ModelError
          ? error
          : new ModelError('provider_failed', { cause: error })
      }
    },
    async run(input) {
      if (closed) throw new Error('模型服务已关闭')
      input.signal.throwIfAborted()
      const target = input.target
      if (!target) throw new ModelError('auth_required')
      const { runtime, model } = await modelRuntime(target)
      input.signal.throwIfAborted()
      if (closed) throw new Error('模型服务已关闭')
      const subscription = target.kind === 'chatgpt'
      if (!/^[\w-]{1,128}$/.test(input.conversationId)) throw new Error('会话标识无效')
      const sessionDir = join(sessionsDir, input.conversationId)
      await mkdir(sessionDir, { recursive: true })
      const stored = await SessionManager.list(cwd, sessionDir)
      if (!stored.length && input.history.length) {
        throw new Error('该会话的模型上下文文件缺失，请新建会话；历史展示记录不能替代模型上下文。')
      }
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        model,
        modelRuntime: runtime,
        noTools: 'all',
        thinkingLevel: 'off',
        resourceLoader: createResources(),
        sessionManager: SessionManager.continueRecent(cwd, sessionDir),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: true },
          retry: { enabled: false },
        }),
      })
      if (closed) {
        session.dispose()
        throw new Error('模型服务已关闭')
      }
      active.set(input.conversationId, session)
      let responseFailed = false
      let failureCode: ModelErrorCode = 'provider_failed'
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          input.onDelta(event.assistantMessageEvent.delta)
        }
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          // Context overflow can fail an attempt before compaction recovers it.
          responseFailed =
            event.message.stopReason === 'error' ||
            event.message.stopReason === 'aborted' ||
            Boolean(subscription && event.message.stopReason !== 'stop')
          if (responseFailed) failureCode = modelFailure(event.message.errorMessage ?? '')
        }
      })
      const abort = (): void => {
        void session.abort().catch(() => {})
      }
      input.signal.addEventListener('abort', abort, { once: true })
      try {
        input.signal.throwIfAborted()
        await session.prompt(input.message)
        await session.waitForIdle()
        input.signal.throwIfAborted()
        if (closed) throw new Error('模型服务已关闭')
        if (responseFailed) throw new ModelError(failureCode)
        return { text: session.getLastAssistantText() ?? '' }
      } catch (error) {
        if (input.signal.aborted) throw error
        if (error instanceof ModelError) {
          if (subscription) await credentials?.failed(target, error.code)
          throw error
        }
        // Provider errors can contain request headers, keys, and endpoint details.
        // The public application error remains independent of provider internals.
        throw new ModelError('provider_failed', { cause: error })
      } finally {
        input.signal.removeEventListener('abort', abort)
        unsubscribe()
        session.dispose()
        active.delete(input.conversationId)
      }
    },
    async deleteConversation(conversationId) {
      if (closed) throw new Error('模型服务已关闭')
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) {
        throw new Error('会话标识必须是 UUID')
      }
      if (active.has(conversationId)) throw new Error('会话仍在生成中，不能删除模型上下文')
      const target = resolve(sessionsDir, conversationId)
      // Validate the resolved absolute target immediately before recursive removal.
      if (dirname(target) !== resolve(sessionsDir)) throw new Error('会话路径无效')
      await rm(target, { recursive: true, force: true })
    },
    async close() {
      closed = true
      shutdown.abort()
      await Promise.allSettled([...active.values()].map((session) => session.abort()))
      for (const session of active.values()) session.dispose()
      active.clear()
      cached.clear()
    },
  }
}
