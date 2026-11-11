import {
  isObject,
  protocols,
  parseConnectionConfig,
  parseHeaders,
  parseIdentifier,
  parseModels,
  parseModelId,
  parseModelRef,
  parseApiKey,
  type ConnectionConfig,
  type ModelDefinition,
  type Protocol,
  type ModelRef,
  type ModelBinding,
} from '@learn-electron/model-connections'
import {
  parseChatGPTLogin,
  parseChatGPTProfile,
  type ChatGPTLogin,
  type ChatGPTProfile,
} from './chatgpt.ts'

export {
  parseModels,
  parseModelRef,
  type ConnectionConfig,
  type ModelDefinition,
  type Protocol,
  type ModelRef,
  type ModelBinding,
}

export interface EndpointInstanceView extends ConnectionConfig {
  id: string
  kind: 'endpoint'
  revision: number
  hasCredential: boolean
  hasHeaders: boolean
}
export interface ChatGPTInstanceView extends ChatGPTProfile {
  kind: 'chatgpt'
  vendor: 'openai'
}
export type ProviderInstanceView = EndpointInstanceView | ChatGPTInstanceView

export interface ProvidersState {
  defaultSelection: ModelRef | null
  instances: ProviderInstanceView[]
  chatgpt: { enabled: boolean; pendingLogin?: ChatGPTLogin }
}
export interface ModelStatus {
  selection: ModelRef | null
  target: ModelRef | null
  model: { provider: string; id: string }
  configured: boolean
  reason?: string
  authMode?: 'chatgpt'
}
export interface SaveProviderRequest extends ConnectionConfig {
  apiKey?: string | null
  headers?: Record<string, string>
}
export interface ModelAdapterView {
  id: Protocol
  name: string
  authentication: Array<'api-key' | 'none'>
}
export const modelAdapters: readonly ModelAdapterView[] = [
  { id: 'openai-chat', name: 'OpenAI Chat Completions', authentication: ['api-key', 'none'] },
  { id: 'openai-responses', name: 'OpenAI Responses', authentication: ['api-key', 'none'] },
  { id: 'anthropic-messages', name: 'Anthropic Messages', authentication: ['api-key'] },
  { id: 'google-generative', name: 'Google Generative AI', authentication: ['api-key'] },
]

export function parseModelAdapters(value: unknown): ModelAdapterView[] {
  if (!Array.isArray(value)) throw new Error('模型适配器响应无效')
  return value.map((item) => {
    if (
      !isObject(item) ||
      !protocols.includes(item.id as Protocol) ||
      typeof item.name !== 'string' ||
      !Array.isArray(item.authentication) ||
      !item.authentication.length ||
      !item.authentication.every((auth) => auth === 'api-key' || auth === 'none')
    )
      throw new Error('模型适配器响应无效')
    return {
      id: item.id as Protocol,
      name: item.name,
      authentication: item.authentication as ModelAdapterView['authentication'],
    }
  })
}
export function parseSaveProvider(value: unknown): SaveProviderRequest {
  const config = parseConnectionConfig(value)
  if (!isObject(value)) throw new Error('供应商配置无效')
  return {
    ...config,
    ...(value.apiKey !== undefined
      ? { apiKey: value.apiKey === null ? null : parseApiKey(value.apiKey) }
      : {}),
    ...(value.headers !== undefined ? { headers: parseHeaders(value.headers) } : {}),
  }
}
export function parseProvidersState(value: unknown): ProvidersState {
  if (
    !isObject(value) ||
    !Array.isArray(value.instances) ||
    !isObject(value.chatgpt) ||
    typeof value.chatgpt.enabled !== 'boolean'
  )
    throw new Error('模型供应商响应无效')
  const pending =
    value.chatgpt.pendingLogin === undefined
      ? undefined
      : parseChatGPTLogin(value.chatgpt.pendingLogin)
  if (pending && pending.status !== 'pending') throw new Error('ChatGPT 登录进度格式无效')
  return {
    defaultSelection:
      value.defaultSelection === null ? null : parseModelRef(value.defaultSelection),
    chatgpt: { enabled: value.chatgpt.enabled, ...(pending ? { pendingLogin: pending } : {}) },
    instances: value.instances.map((entry) => {
      if (isObject(entry) && entry.kind === 'chatgpt')
        return { ...parseChatGPTProfile(entry), kind: 'chatgpt', vendor: 'openai' }
      const config = parseConnectionConfig(entry)
      if (
        !isObject(entry) ||
        entry.kind !== 'endpoint' ||
        !Number.isSafeInteger(entry.revision) ||
        Number(entry.revision) < 1 ||
        typeof entry.hasCredential !== 'boolean' ||
        typeof entry.hasHeaders !== 'boolean'
      )
        throw new Error('模型供应商响应无效')
      return {
        ...config,
        id: parseIdentifier(entry.id),
        kind: 'endpoint',
        revision: Number(entry.revision),
        hasCredential: entry.hasCredential,
        hasHeaders: entry.hasHeaders,
      }
    }),
  }
}
export function parseModelStatus(value: unknown): ModelStatus {
  if (
    !isObject(value) ||
    !isObject(value.model) ||
    typeof value.model.provider !== 'string' ||
    typeof value.model.id !== 'string' ||
    typeof value.configured !== 'boolean' ||
    (value.reason !== undefined && typeof value.reason !== 'string') ||
    (value.authMode !== undefined && value.authMode !== 'chatgpt')
  )
    throw new Error('服务端模型状态格式不兼容，请刷新页面。')
  return {
    selection: value.selection === null ? null : parseModelRef(value.selection),
    target: value.target === null ? null : parseModelRef(value.target),
    model: { provider: value.model.provider, id: value.model.id },
    configured: value.configured,
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
    ...(value.authMode === 'chatgpt' ? { authMode: 'chatgpt' } : {}),
  }
}
export function parseModelBinding(value: unknown): ModelBinding {
  if (!isObject(value)) throw new Error('模型绑定无效')
  return {
    instanceId: parseIdentifier(value.instanceId),
    modelId: value.modelId === null ? null : parseModelId(value.modelId),
  }
}
export function parseProviderTest(value: unknown): { modelId: string } {
  if (!isObject(value)) throw new Error('连接测试参数必须是 JSON 对象')
  return { modelId: parseModelId(value.modelId) }
}
export function parseCreateConversation(value: unknown): { selection?: ModelRef } {
  if (!isObject(value)) throw new Error('会话参数必须是 JSON 对象')
  return value.selection === undefined ? {} : { selection: parseModelRef(value.selection) }
}

export interface ProviderPreset {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string
  authentication: 'api-key' | 'none'
}

/** App presets only; the wire protocol and model ID remain editable. */
export const providerPresets: readonly ProviderPreset[] = [
  {
    id: 'custom',
    name: '自定义提供商',
    protocol: 'openai-chat',
    baseUrl: '',
    authentication: 'api-key',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    authentication: 'api-key',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    authentication: 'api-key',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    authentication: 'api-key',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    protocol: 'google-generative',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authentication: 'api-key',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:11434/v1',
    authentication: 'none',
  },
]
