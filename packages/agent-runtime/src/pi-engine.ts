import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent'
import type { AgentEngine, EngineInfo, PiEngineOptions } from './index.ts'

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

  // In-memory credentials and no model file: provider keys resolve from server
  // environment only, without reading or writing a user's global Pi profile.
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  })
  const requestedProvider = options.provider ?? process.env.PI_PROVIDER
  const requestedModel = options.model ?? process.env.PI_MODEL
  const available = runtime.getAvailableSnapshot()
  const model = available.find(
    (candidate) =>
      (!requestedProvider || candidate.provider === requestedProvider) &&
      (!requestedModel || candidate.id === requestedModel),
  )
  const active = new Map<string, AgentSession>()
  let closed = false

  return {
    meta() {
      return Promise.resolve<EngineInfo>({
        engine: 'pi',
        model: {
          provider: model?.provider ?? requestedProvider ?? 'unconfigured',
          id: model?.id ?? requestedModel ?? 'unconfigured',
        },
        configured: Boolean(model),
        capabilities: { tools: false },
      })
    },
    async run(input) {
      if (closed) throw new Error('模型服务已关闭')
      input.signal.throwIfAborted()
      if (!model) {
        throw new Error(
          '未配置可用模型。请在服务端设置 PI_PROVIDER、PI_MODEL 和对应提供商的 API_KEY。',
        )
      }
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
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          input.onDelta(event.assistantMessageEvent.delta)
        }
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          // Context overflow can fail an attempt before compaction recovers it.
          responseFailed =
            event.message.stopReason === 'error' || event.message.stopReason === 'aborted'
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
        if (responseFailed) throw new Error('provider_failed')
        return { text: session.getLastAssistantText() ?? '' }
      } catch (error) {
        if (input.signal.aborted) throw error
        // Provider errors can contain request headers, keys, and endpoint details.
        // The public application error remains independent of provider internals.
        throw new Error('模型请求失败，请检查服务端模型配置、凭证、额度与网络。', { cause: error })
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
      await Promise.allSettled([...active.values()].map((session) => session.abort()))
      for (const session of active.values()) session.dispose()
      active.clear()
    },
  }
}
