/** Application-owned model configuration. No SDK, transport, storage or platform dependencies. */
export const protocols = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'google-generative',
] as const
export type Protocol = (typeof protocols)[number]

export interface ModelDefinition {
  id: string
  name: string
  contextWindow: number
  maxOutputTokens: number
}

export interface Compatibility {
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  supportsDeveloperRole?: boolean
  supportsUsageInStreaming?: boolean
  supportsStore?: boolean
}

export interface ConnectionConfig {
  vendor: string
  name: string
  protocol: Protocol
  baseUrl: string
  authentication: 'api-key' | 'none'
  models: ModelDefinition[]
  compatibility: Compatibility
}

export interface ModelRef {
  instanceId: string
  modelId: string
}

interface TargetBase {
  instanceId: string
  revision: number
  provider: string
  model: ModelDefinition
}

export type ModelTarget = TargetBase &
  (
    | { kind: 'chatgpt' }
    | {
        kind: 'endpoint'
        protocol: Protocol
        baseUrl: string
        authentication: 'api-key' | 'none'
        compatibility: Compatibility
      }
  )

export interface RequestCredentials {
  apiKey?: string
  headers: Record<string, string>
}

export interface CredentialResolver {
  credentials(target: ModelTarget, signal: AbortSignal): Promise<RequestCredentials>
  failed(target: ModelTarget, code: ModelErrorCode): Promise<void>
}

export type ModelErrorCode =
  | 'auth_required'
  | 'permission_missing'
  | 'quota_exceeded'
  | 'model_unavailable'
  | 'provider_failed'
  | 'connection_changed'
const messages: Record<ModelErrorCode, string> = {
  auth_required: '模型凭据不可用，请更新 API Key 或重新登录 ChatGPT。',
  permission_missing: '尚未获得使用 ChatGPT 计划的权限，请重新授权。',
  quota_exceeded: '已达到模型用量限制，请检查额度或管理用量。',
  model_unavailable: '当前模型不可用，请检查模型 ID 或重新选择模型。',
  provider_failed: '模型请求失败，请检查连接配置、凭据、额度与网络。',
  connection_changed: '会话模型绑定或实例配置已改变，请检查该实例或新建会话。',
}
export class ModelError extends Error {
  readonly code: ModelErrorCode
  constructor(code: ModelErrorCode, options?: ErrorOptions) {
    super(messages[code], options)
    this.code = code
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{1,128}$/.test(value)) throw new Error('连接标识无效')
  return value
}

export function parseModelId(value: unknown): string {
  return text(value, '模型 ID', 200)
}

export function parseModelRef(value: unknown): ModelRef {
  if (!isObject(value)) throw new Error('模型选择无效')
  return { instanceId: parseIdentifier(value.instanceId), modelId: parseModelId(value.modelId) }
}

export function modelRef(target: ModelTarget): ModelRef {
  return { instanceId: target.instanceId, modelId: target.model.id }
}

function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || hasControls(value))
    throw new Error(`${label}无效`)
  return value.trim()
}

function hasControls(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  )
}

export function parseApiKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || hasControls(value))
    throw new Error('API Key 无效；清除密钥请使用 null')
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 10_000_000)
    throw new Error(`${label}无效`)
  return value
}

type ModelInput = Pick<ModelDefinition, 'id'> & Partial<Omit<ModelDefinition, 'id'>>
type ConnectionInput = Omit<ConnectionConfig, 'vendor' | 'models' | 'compatibility'> &
  Partial<Pick<ConnectionConfig, 'vendor' | 'compatibility'>> & { models: ModelInput[] }

function normalizeModelDefinition(value: ModelInput): ModelDefinition {
  const id = value.id.trim()
  const contextWindow = value.contextWindow ?? 32768
  const maxOutputTokens = value.maxOutputTokens ?? Math.min(4096, contextWindow)
  if (maxOutputTokens > contextWindow) throw new Error('最大输出长度不能超过上下文长度')
  return {
    id,
    name: value.name === undefined ? id : value.name.trim(),
    contextWindow,
    maxOutputTokens,
  }
}

/** Normalize structurally validated input and enforce model relationships. */
export function normalizeModels(value: readonly ModelInput[]): ModelDefinition[] {
  const models = value.map(normalizeModelDefinition)
  assertUniqueModelIds(models)
  return models
}

function assertUniqueModelIds(models: readonly ModelDefinition[]): void {
  if (new Set(models.map(({ id }) => id)).size !== models.length)
    throw new Error('模型 ID 不能重复')
}

export function parseModelDefinition(value: unknown): ModelDefinition {
  if (!isObject(value)) throw new Error('模型配置无效')
  return normalizeModelDefinition({
    id: parseModelId(value.id),
    ...(value.name === undefined ? {} : { name: text(value.name, '模型名称', 200) }),
    ...(value.contextWindow === undefined
      ? {}
      : { contextWindow: positiveInteger(value.contextWindow, '上下文长度') }),
    ...(value.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: positiveInteger(value.maxOutputTokens, '最大输出长度') }),
  })
}

export function parseModels(value: unknown): ModelDefinition[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('模型列表无效，最多 200 个模型')
  const models = value.map(parseModelDefinition)
  assertUniqueModelIds(models)
  return models
}

export function parseCompatibility(value: unknown): Compatibility {
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error('协议兼容配置无效')
  const result: Compatibility = {}
  if (value.maxTokensField !== undefined) {
    if (value.maxTokensField !== 'max_tokens' && value.maxTokensField !== 'max_completion_tokens')
      throw new Error('输出参数名称无效')
    result.maxTokensField = value.maxTokensField
  }
  for (const key of [
    'supportsDeveloperRole',
    'supportsUsageInStreaming',
    'supportsStore',
  ] as const) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'boolean') throw new Error('协议兼容开关无效')
    result[key] = value[key]
  }
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'maxTokensField',
          'supportsDeveloperRole',
          'supportsUsageInStreaming',
          'supportsStore',
        ].includes(key),
    )
  )
    throw new Error('未知的协议兼容选项')
  return result
}

export function parseConnectionConfig(value: unknown): ConnectionConfig {
  if (!isObject(value)) throw new Error('连接配置必须是 JSON 对象')
  if (!protocols.includes(value.protocol as Protocol)) throw new Error('不支持的模型协议')
  const protocol = value.protocol as Protocol
  const authentication = value.authentication
  if (authentication !== 'api-key' && authentication !== 'none') throw new Error('认证方式无效')
  return normalizeConnectionConfig({
    vendor: value.vendor === undefined ? 'custom' : text(value.vendor, '供应商标识', 100),
    name: text(value.name, '连接名称', 100),
    protocol,
    baseUrl: text(value.baseUrl, 'API 地址', 2000),
    authentication,
    models: parseModels(value.models),
    compatibility: parseCompatibility(value.compatibility),
  })
}

/** Structural checks belong to the caller's boundary; these rules apply to every transport. */
export function normalizeConnectionConfig(value: ConnectionInput): ConnectionConfig {
  const { protocol, authentication } = value
  const url = new URL(value.baseUrl.trim())
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('API 地址须为无凭据、查询参数和片段的 HTTP(S) 地址')
  if (authentication === 'none' && protocol !== 'openai-chat' && protocol !== 'openai-responses')
    throw new Error('无需认证仅适用于 OpenAI 兼容协议')
  const compatibility = value.compatibility ?? {}
  if (protocol !== 'openai-chat' && Object.keys(compatibility).length)
    throw new Error('兼容选项仅适用于 Chat Completions 协议')
  return {
    vendor: value.vendor === undefined ? 'custom' : value.vendor.trim(),
    name: value.name.trim(),
    protocol,
    baseUrl: url.href.replace(/\/+$/, ''),
    authentication,
    models: normalizeModels(value.models),
    compatibility,
  }
}

export function assertAllowedCredentialHeaders(headers: Record<string, unknown>): void {
  if (
    Object.keys(headers).some((name) =>
      [
        'host',
        'content-length',
        'connection',
        'transfer-encoding',
        'proxy-authorization',
        '__proto__',
        'constructor',
        'prototype',
      ].includes(name.toLowerCase()),
    )
  )
    throw new Error('自定义请求头名称或内容无效')
}

/** Header values are literal secrets; never evaluate environment or command expressions. */
export function parseHeaders(value: unknown): Record<string, string> {
  if (!isObject(value) || Object.keys(value).length > 20) throw new Error('自定义请求头无效')
  assertAllowedCredentialHeaders(value)
  const result: Record<string, string> = {}
  for (const [name, valueText] of Object.entries(value)) {
    if (
      !/^[!#$%&'*+.^_`|~\w-]+$/.test(name) ||
      typeof valueText !== 'string' ||
      valueText.length > 8192 ||
      hasControls(valueText)
    )
      throw new Error('自定义请求头名称或内容无效')
    result[name] = valueText
  }
  return result
}
