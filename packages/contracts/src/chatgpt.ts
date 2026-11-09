export interface ChatGPTProfile {
  id: string
  label: string
  status: 'signed_out' | 'connected' | 'reauth_required'
  planUsage: boolean
  modelId: string | null
}

export interface ChatGPTState {
  enabled: boolean
  activeId: string | null
  profiles: ChatGPTProfile[]
  pendingLogin?: ChatGPTLogin
}

export interface ChatGPTModel {
  id: string
  name: string
}

export interface ChatGPTLogin {
  id: string
  status: 'pending' | 'completed' | 'cancelled' | 'expired' | 'failed'
  authorizationUrl: string
  expiresAt: string
  error?: string
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseProfileId(value: unknown): string {
  if (
    !object(value) ||
    typeof value.profileId !== 'string' ||
    !/^[\w-]{1,128}$/.test(value.profileId)
  )
    throw new Error('连接标识无效')
  return value.profileId
}

export function parseLoginRequest(value: unknown): { profileId?: string } {
  if (!object(value)) throw new Error('请求必须是 JSON 对象')
  return value.profileId === undefined ? {} : { profileId: parseProfileId(value) }
}

export function parseModelSelection(value: unknown): string {
  if (
    !object(value) ||
    typeof value.modelId !== 'string' ||
    !value.modelId ||
    value.modelId.length > 200
  )
    throw new Error('模型标识无效')
  return value.modelId
}

export function parseChatGPTState(value: unknown): ChatGPTState {
  if (
    !object(value) ||
    typeof value.enabled !== 'boolean' ||
    (value.activeId !== null && typeof value.activeId !== 'string') ||
    !Array.isArray(value.profiles) ||
    !value.profiles.every(
      (profile) =>
        object(profile) &&
        typeof profile.id === 'string' &&
        typeof profile.label === 'string' &&
        typeof profile.status === 'string' &&
        ['signed_out', 'connected', 'reauth_required'].includes(String(profile.status)) &&
        typeof profile.planUsage === 'boolean' &&
        (profile.modelId === null || typeof profile.modelId === 'string'),
    )
  ) {
    throw new Error('ChatGPT 连接状态格式无效')
  }
  if (
    value.pendingLogin !== undefined &&
    parseChatGPTLogin(value.pendingLogin).status !== 'pending'
  )
    throw new Error('ChatGPT 登录进度格式无效')
  return value as unknown as ChatGPTState
}

export function parseChatGPTModels(value: unknown): ChatGPTModel[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (model) => object(model) && typeof model.id === 'string' && typeof model.name === 'string',
    )
  )
    throw new Error('模型目录格式无效')
  return value as ChatGPTModel[]
}

export function parseChatGPTLogin(value: unknown): ChatGPTLogin {
  if (
    !object(value) ||
    typeof value.id !== 'string' ||
    typeof value.status !== 'string' ||
    !['pending', 'completed', 'cancelled', 'expired', 'failed'].includes(String(value.status)) ||
    typeof value.authorizationUrl !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    (value.error !== undefined && typeof value.error !== 'string')
  )
    throw new Error('登录进度格式无效')
  return value as unknown as ChatGPTLogin
}

export function parseLogoutResult(value: unknown): { revoked: boolean } {
  if (!object(value) || typeof value.revoked !== 'boolean') throw new Error('退出结果格式无效')
  return { revoked: value.revoked }
}
