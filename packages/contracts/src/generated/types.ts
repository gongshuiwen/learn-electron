// Generated from api/openapi.yaml. DO NOT EDIT.
// Run npm run generate:contracts.

/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ApiVersion".
 */
export type ApiVersion = 1
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "Identifier".
 */
export type Identifier = string
/**
 * 原始 UTF-16 长度最多 200，拒绝控制字符，解析后去除首尾空白
 *
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ModelId".
 */
export type ModelId = string
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ServiceMeta".
 */
export type ServiceMeta = ModelStatus & {
  apiVersion: ApiVersion
  engine: 'pi' | 'mock'
  capabilities: {
    tools: boolean
  }
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "Conversations".
 */
export type Conversations = Conversation[]
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "RunStatus".
 */
export type RunStatus =
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted'
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "Sequence".
 */
export type Sequence = number
/**
 * snapshot 的会话和 sequence 必须与外层一致；其 run 可为会话的较新任务。
 * run.updated 的 run.id 和 conversationId 必须与外层一致。由语义校验检查。
 *
 *
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "RunEvent".
 */
export type RunEvent = {
  apiVersion: ApiVersion
  conversationId: string
  runId: string
  sequence: Sequence
} & (
  | {
      type: 'snapshot'
      snapshot: ConversationSnapshot
    }
  | {
      type: 'message.delta'
      messageId: string
      delta: string
    }
  | {
      type: 'message.completed'
      message: Message
    }
  | {
      type: 'run.updated'
      run: Run
    }
)
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "Protocol".
 */
export type Protocol =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative'
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ModelDefinition".
 */
export type ModelDefinition = ModelDefinitionInput & {
  name: string
  contextWindow: number
  maxOutputTokens: number
}
/**
 * 模型 ID 在 trim 后唯一；由领域校验检查
 *
 * @maxItems 200
 *
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ModelDefinitions".
 */
export type ModelDefinitions = ModelDefinition[]
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ConnectionConfig".
 */
export type ConnectionConfig = ConnectionConfigInput & {
  vendor: string
  compatibility: Compatibility
  models: ModelDefinitions
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "SaveProviderRequest".
 */
export type SaveProviderRequest = ConnectionConfigInput & {
  /**
   * 缺省保留，字符串替换，null 清除；按字面量保存
   */
  apiKey?: string | null
  headers?: CredentialHeaders
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "CreateProviderRequest".
 */
export type CreateProviderRequest = SaveProviderRequest | CreateChatGPTProviderRequest
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "EndpointInstanceView".
 */
export type EndpointInstanceView = ConnectionConfig & {
  id: Identifier
  kind: 'endpoint'
  revision: number
  hasCredential: boolean
  hasHeaders: boolean
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ChatGPTInstanceView".
 */
export type ChatGPTInstanceView = ChatGPTProfile & {
  kind: 'chatgpt'
  vendor: 'openai'
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ProviderInstanceView".
 */
export type ProviderInstanceView = EndpointInstanceView | ChatGPTInstanceView
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ChatGPTLogin".
 */
export type ChatGPTLogin = {
  id: Identifier
  authorizationUrl: string
  expiresAt: string
  error?: string
} & (
  | {
      status: 'completed'
      instanceId: Identifier
    }
  | {
      status: 'pending' | 'cancelled' | 'expired' | 'failed'
    }
)
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ModelAdapters".
 */
export type ModelAdapters = ModelAdapterView[]
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ChatGPTModels".
 */
export type ChatGPTModels = ChatGPTModel[]

export interface HttpSchemas {
  ApiVersion: ApiVersion
  ServiceVersionInfo: ServiceVersionInfo
  Identifier: Identifier
  ModelId: ModelId
  ModelRef: ModelRef
  ModelBinding: ModelBinding
  ModelStatus: ModelStatus
  ServiceMeta: ServiceMeta
  Conversation: Conversation
  Conversations: Conversations
  Message: Message
  RunStatus: RunStatus
  Run: Run
  Sequence: Sequence
  ConversationSnapshot: ConversationSnapshot
  RunEvent: RunEvent
  StartRunRequest: StartRunRequest
  RenameConversationRequest: RenameConversationRequest
  CreateConversationRequest: CreateConversationRequest
  ApiError: ApiError
  Protocol: Protocol
  ModelDefinitionInput: ModelDefinitionInput
  ModelDefinition: ModelDefinition
  ModelDefinitions: ModelDefinitions
  Compatibility: Compatibility
  ConnectionConfigInput: ConnectionConfigInput
  ConnectionConfig: ConnectionConfig
  CredentialHeaders: CredentialHeaders
  SaveProviderRequest: SaveProviderRequest
  CreateChatGPTProviderRequest: CreateChatGPTProviderRequest
  CreateProviderRequest: CreateProviderRequest
  EndpointInstanceView: EndpointInstanceView
  ChatGPTProfile: ChatGPTProfile
  ChatGPTInstanceView: ChatGPTInstanceView
  ProviderInstanceView: ProviderInstanceView
  ProvidersState: ProvidersState
  ModelAdapterView: ModelAdapterView
  ModelAdapters: ModelAdapters
  ProviderTestRequest: ProviderTestRequest
  ChatGPTModel: ChatGPTModel
  ChatGPTModels: ChatGPTModels
  ChatGPTLogin: ChatGPTLogin
  LogoutResult: LogoutResult
}
/**
 * 在完整元数据校验前识别版本不兼容，仅用于协议诊断
 *
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ServiceVersionInfo".
 */
export interface ServiceVersionInfo {
  apiVersion: number
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ModelRef".
 */
export interface ModelRef {
  instanceId: Identifier
  modelId: ModelId
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ModelBinding".
 */
export interface ModelBinding {
  instanceId: Identifier
  modelId: ModelId | null
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ModelStatus".
 */
export interface ModelStatus {
  selection: ModelRef | null
  target: ModelRef | null
  model: {
    provider: string
    id: string
  }
  configured: boolean
  reason?: string
  authMode?: 'chatgpt'
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "Conversation".
 */
export interface Conversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  selection?: ModelRef
  binding?: ModelBinding
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "Message".
 */
export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  status: 'streaming' | 'complete' | 'interrupted'
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "Run".
 */
export interface Run {
  id: string
  conversationId: string
  status: RunStatus
  createdAt: string
  updatedAt: string
  error?: string
  errorCode?: string
  target?: ModelRef
}
/**
 * run 非空时 conversationId 必须等于 conversation.id；由语义校验检查
 *
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ConversationSnapshot".
 */
export interface ConversationSnapshot {
  conversation: Conversation
  messages: Message[]
  run: Run | null
  sequence: Sequence
  model?: ModelStatus
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "StartRunRequest".
 */
export interface StartRunRequest {
  /**
   * 原始 UTF-16 长度最多 32000；保存和幂等比较前 trim
   */
  message: string
  requestId: string
  expectedTarget?: ModelRef
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "RenameConversationRequest".
 */
export interface RenameConversationRequest {
  /**
   * trim 后 UTF-16 长度为 1–100
   */
  title: string
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "CreateConversationRequest".
 */
export interface CreateConversationRequest {
  selection?: ModelRef
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ApiError".
 */
export interface ApiError {
  error: {
    code: string
    message: string
  }
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ModelDefinitionInput".
 */
export interface ModelDefinitionInput {
  id: ModelId
  name?: ModelId
  contextWindow?: number
  /**
   * 缺省为 min(4096, contextWindow)，不得超过上下文；由领域规范化检查
   */
  maxOutputTokens?: number
}
/**
 * 缺省为空；只有 openai-chat 可以使用非空兼容选项
 *
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "Compatibility".
 */
export interface Compatibility {
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  supportsDeveloperRole?: boolean
  supportsUsageInStreaming?: boolean
  supportsStore?: boolean
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ConnectionConfigInput".
 */
export interface ConnectionConfigInput {
  vendor?: string
  name: string
  protocol: Protocol
  /**
   * HTTP(S) 地址，无用户名、密码、查询和片段；解析后移除末尾斜杠
   */
  baseUrl: string
  /**
   * none 仅适用于 OpenAI 兼容协议
   */
  authentication: 'api-key' | 'none'
  /**
   * @maxItems 200
   */
  models: ModelDefinitionInput[]
  compatibility?: Compatibility
}
/**
 * 值按字面量处理；缺省保留，空对象清除。拒绝 Host、Content-Length、Connection、
 * Transfer-Encoding、Proxy-Authorization、__proto__、constructor、prototype（忽略大小写），
 * 由领域校验检查。仅写入，不出现在读取 DTO 中。
 *
 *
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "CredentialHeaders".
 */
export interface CredentialHeaders {
  [k: string]: string
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "CreateChatGPTProviderRequest".
 */
export interface CreateChatGPTProviderRequest {
  kind: 'chatgpt'
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ChatGPTProfile".
 */
export interface ChatGPTProfile {
  id: Identifier
  name: string
  status: 'signed_out' | 'connected' | 'reauth_required' | 'authorizing' | 'busy'
  planUsage: boolean
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ProvidersState".
 */
export interface ProvidersState {
  defaultSelection: ModelRef | null
  instances: ProviderInstanceView[]
  chatgpt: {
    enabled: boolean
    pendingLogin?: ChatGPTLogin & {
      status?: 'pending'
    }
  }
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ModelAdapterView".
 */
export interface ModelAdapterView {
  id: Protocol
  name: string
  /**
   * @minItems 1
   */
  authentication: ('api-key' | 'none')[]
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ProviderTestRequest".
 */
export interface ProviderTestRequest {
  modelId: ModelId
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "ChatGPTModel".
 */
export interface ChatGPTModel {
  id: string
  name: string
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "LogoutResult".
 */
export interface LogoutResult {
  revoked: boolean
}
/**
 * This interface was referenced by `HttpSchemas`'s JSON-Schema
 * via the `definition` "HttpPathParameters".
 */
export interface HttpPathParameters {
  getConversation: {
    id: string
  }
  renameConversation: {
    id: string
  }
  deleteConversation: {
    id: string
  }
  selectConversationModel: {
    id: string
  }
  startRun: {
    id: string
  }
  streamRunEvents: {
    id: string
  }
  cancelRun: {
    id: string
  }
  updateProvider: {
    id: string
  }
  deleteProvider: {
    id: string
  }
  listProviderModels: {
    id: string
  }
  refreshProviderModels: {
    id: string
  }
  testProvider: {
    id: string
  }
  beginProviderLogin: {
    id: string
  }
  logoutProvider: {
    id: string
  }
  getLoginAttempt: {
    id: string
  }
  cancelLoginAttempt: {
    id: string
  }
}
