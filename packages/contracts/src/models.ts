import {
  normalizeConnectionConfig,
  normalizeModels,
  assertAllowedCredentialHeaders,
} from '@learn-electron/model-connections'
import { parseChatGPTLogin, parseChatGPTProfile } from './chatgpt.ts'
import { parseSchema } from './validation.ts'
import type {
  ConnectionConfig,
  ModelAdapterView,
  ModelDefinition,
  ModelRef,
  ModelStatus,
  ProvidersState,
  ProviderTestRequest,
  SaveProviderRequest,
  CreateConversationRequest,
  CreateChatGPTProviderRequest,
  CreateProviderRequest,
  CredentialHeaders,
} from './generated/types.ts'

export type {
  ConnectionConfig,
  ModelDefinition,
  Protocol,
  ModelRef,
  ModelBinding,
  EndpointInstanceView,
  ChatGPTInstanceView,
  ProviderInstanceView,
  ProvidersState,
  ModelStatus,
  SaveProviderRequest,
  ModelAdapterView,
  CreateProviderRequest,
} from './generated/types.ts'

export const modelAdapters: readonly ModelAdapterView[] = [
  { id: 'openai-chat', name: 'OpenAI Chat Completions', authentication: ['api-key', 'none'] },
  { id: 'openai-responses', name: 'OpenAI Responses', authentication: ['api-key', 'none'] },
  { id: 'anthropic-messages', name: 'Anthropic Messages', authentication: ['api-key'] },
  { id: 'google-generative', name: 'Google Generative AI', authentication: ['api-key'] },
]

export function parseModelAdapters(value: unknown): ModelAdapterView[] {
  return parseSchema('ModelAdapters', value, '模型适配器响应无效').map((item) => ({
    id: item.id,
    name: item.name,
    authentication: item.authentication,
  }))
}

export function parseModels(value: unknown): ModelDefinition[] {
  return normalizeModels(parseSchema('ModelDefinitions', value, '模型目录格式无效'))
}

export function parseModelRef(value: unknown): ModelRef {
  const ref = parseSchema('ModelRef', value, '模型选择无效')
  return { instanceId: ref.instanceId, modelId: ref.modelId.trim() }
}

type NormalizedProviderRequest = ConnectionConfig & Pick<SaveProviderRequest, 'apiKey' | 'headers'>

export function parseSaveProvider(value: unknown): NormalizedProviderRequest {
  return normalizeSaveProvider(
    parseSchema('SaveProviderRequest', value, '供应商配置或凭据格式无效'),
  )
}

function normalizeSaveProvider(request: SaveProviderRequest): NormalizedProviderRequest {
  if (request.headers !== undefined) assertAllowedCredentialHeaders(request.headers)
  return {
    ...normalizeConnectionConfig(request),
    ...(request.apiKey !== undefined ? { apiKey: request.apiKey } : {}),
    ...(request.headers !== undefined ? { headers: { ...request.headers } } : {}),
  }
}

export function parseCredentialHeaders(value: unknown): CredentialHeaders {
  const headers = parseSchema(
    'CredentialHeaders',
    value,
    '请求头名称或内容无效，请填写字符串 JSON 对象。',
  )
  assertAllowedCredentialHeaders(headers)
  return { ...headers }
}

function isChatGPTRequest(request: CreateProviderRequest): request is CreateChatGPTProviderRequest {
  return 'kind' in request && request.kind === 'chatgpt'
}

export function parseCreateProvider(
  value: unknown,
): NormalizedProviderRequest | CreateChatGPTProviderRequest {
  const request = parseSchema('CreateProviderRequest', value, '供应商配置无效')
  return isChatGPTRequest(request) ? { kind: 'chatgpt' } : normalizeSaveProvider(request)
}

export function parseProvidersState(value: unknown): ProvidersState {
  const state = parseSchema('ProvidersState', value, '模型供应商响应无效')
  // Validate the wire DTO before normalization, then project only public fields.
  const instances = state.instances.map((entry) => {
    if (entry.kind === 'chatgpt')
      return { ...parseChatGPTProfile(entry), kind: entry.kind, vendor: entry.vendor }
    return {
      ...normalizeConnectionConfig(entry),
      id: entry.id,
      kind: entry.kind,
      revision: entry.revision,
      hasCredential: entry.hasCredential,
      hasHeaders: entry.hasHeaders,
    }
  })
  return {
    defaultSelection:
      state.defaultSelection === null ? null : parseModelRef(state.defaultSelection),
    instances,
    chatgpt: {
      enabled: state.chatgpt.enabled,
      ...(state.chatgpt.pendingLogin
        ? {
            pendingLogin: {
              ...parseChatGPTLogin(state.chatgpt.pendingLogin),
              status: state.chatgpt.pendingLogin.status,
            },
          }
        : {}),
    },
  }
}

export function parseModelStatus(value: unknown): ModelStatus {
  const status = parseSchema('ModelStatus', value, '服务端模型状态格式不兼容，请刷新页面。')
  return {
    selection: status.selection === null ? null : parseModelRef(status.selection),
    target: status.target === null ? null : parseModelRef(status.target),
    model: { provider: status.model.provider, id: status.model.id },
    configured: status.configured,
    ...(status.reason !== undefined ? { reason: status.reason } : {}),
    ...(status.authMode === undefined ? {} : { authMode: status.authMode }),
  }
}

export function parseProviderTest(value: unknown): ProviderTestRequest {
  const request = parseSchema('ProviderTestRequest', value, '连接测试参数无效')
  return { modelId: request.modelId.trim() }
}

export function parseCreateConversation(value: unknown): CreateConversationRequest {
  const request = parseSchema('CreateConversationRequest', value, '会话参数无效')
  return request.selection === undefined ? {} : { selection: parseModelRef(request.selection) }
}

export type ProviderPreset = Pick<
  ConnectionConfig,
  'name' | 'protocol' | 'baseUrl' | 'authentication'
> & {
  id: string
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
