import { setTimeout as delay } from 'node:timers/promises'

export interface EngineInfo {
  engine: 'pi' | 'mock'
  model: { provider: string; id: string }
  configured: boolean
  capabilities: { tools: boolean }
  authMode?: 'chatgpt'
  connectionId?: string
}

export interface EngineRunInput {
  conversationId: string
  message: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  connectionId?: string
  signal: AbortSignal
  onDelta: (delta: string) => void
}

/** Application port: transports and storage do not depend on Pi session types. */
export interface AgentEngine {
  meta(): Promise<EngineInfo>
  run(input: EngineRunInput): Promise<{ text: string }>
  deleteConversation?(conversationId: string): Promise<void>
  close(): Promise<void>
}

export interface PiEngineOptions {
  dataDir: string
  provider?: string
  model?: string
  subscription?: OpenAISubscription | undefined
}

/** App-owned OAuth lifecycle; Pi never receives refresh tokens or storage access. */
export interface OpenAISubscription {
  snapshot(): { connectionId: string; modelId: string } | undefined
  token(connectionId: string, signal: AbortSignal): Promise<string>
  failed(code: ModelErrorCode): Promise<void>
}

export type ModelErrorCode =
  | 'auth_required'
  | 'permission_missing'
  | 'quota_exceeded'
  | 'model_unavailable'
  | 'provider_failed'
  | 'connection_changed'

const modelErrors: Record<ModelErrorCode, string> = {
  auth_required: 'ChatGPT 授权已失效，请重新登录。',
  permission_missing: '尚未获得使用 ChatGPT 计划的权限，请重新授权。',
  quota_exceeded: '已达到 ChatGPT 计划或本应用的用量限制，请查看管理用量。',
  model_unavailable: '当前模型不可用，请重新选择模型。',
  provider_failed: '模型请求失败，请检查服务端模型配置、凭证、额度与网络。',
  connection_changed: '会话与当前模型连接不匹配，请切回原连接或新建会话。',
}

export class ModelError extends Error {
  readonly code: ModelErrorCode
  constructor(code: ModelErrorCode, options?: ErrorOptions) {
    super(modelErrors[code], options)
    this.code = code
  }
}

export async function getOpenAIModels(): Promise<Array<{ id: string; name: string }>> {
  const { openaiProvider } = await import('@earendil-works/pi-ai/providers/openai')
  return openaiProvider()
    .getModels()
    .map(({ id, name }) => ({ id, name }))
}

export async function createPiEngine(options: PiEngineOptions): Promise<AgentEngine> {
  const { createPiEngine: create } = await import('./pi-engine.ts')
  return create(options)
}

/** Explicit demo/test engine. It never silently replaces an unconfigured Pi. */
export function createMockEngine(): AgentEngine {
  let closed = false
  return {
    meta() {
      return Promise.resolve<EngineInfo>({
        engine: 'mock',
        model: { provider: 'demo', id: 'deterministic' },
        configured: true,
        capabilities: { tools: false },
      })
    },
    async run(input) {
      if (closed) throw new Error('演示引擎已关闭')
      const text = `演示回复：${input.message}\n\n这是显式启用的模拟引擎，未调用真实模型。`
      for (const delta of text.match(/.{1,5}/gs) ?? []) {
        await delay(18, undefined, { signal: input.signal })
        input.onDelta(delta)
      }
      return { text }
    },
    close() {
      closed = true
      return Promise.resolve()
    },
  }
}
