import { isObject, parseIdentifier } from '@learn-electron/model-connections'

export interface ChatGPTProfile {
  id: string
  name: string
  status: 'signed_out' | 'connected' | 'reauth_required' | 'authorizing' | 'busy'
  planUsage: boolean
}

export interface ChatGPTModel {
  id: string
  name: string
}

interface LoginDetails {
  id: string
  authorizationUrl: string
  expiresAt: string
  error?: string
}

export type ChatGPTLogin = LoginDetails &
  (
    | { status: 'completed'; instanceId: string }
    | { status: 'pending' | 'cancelled' | 'expired' | 'failed' }
  )

export function parseChatGPTProfile(value: unknown): ChatGPTProfile {
  if (
    !isObject(value) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    typeof value.status !== 'string' ||
    !['signed_out', 'connected', 'reauth_required', 'authorizing', 'busy'].includes(value.status) ||
    typeof value.planUsage !== 'boolean'
  )
    throw new Error('ChatGPT 连接状态格式无效')
  return {
    id: parseIdentifier(value.id),
    name: value.name,
    status: value.status as ChatGPTProfile['status'],
    planUsage: value.planUsage,
  }
}

export function parseChatGPTModels(value: unknown): ChatGPTModel[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (model) => isObject(model) && typeof model.id === 'string' && typeof model.name === 'string',
    )
  )
    throw new Error('模型目录格式无效')
  return value as ChatGPTModel[]
}

export function parseChatGPTLogin(value: unknown): ChatGPTLogin {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.status !== 'string' ||
    !['pending', 'completed', 'cancelled', 'expired', 'failed'].includes(String(value.status)) ||
    typeof value.authorizationUrl !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    (value.error !== undefined && typeof value.error !== 'string')
  )
    throw new Error('登录进度格式无效')
  const details: LoginDetails = {
    id: parseIdentifier(value.id),
    authorizationUrl: value.authorizationUrl,
    expiresAt: value.expiresAt,
    ...(value.error !== undefined ? { error: value.error } : {}),
  }
  return value.status === 'completed'
    ? { ...details, status: 'completed', instanceId: parseIdentifier(value.instanceId) }
    : { ...details, status: value.status as 'pending' | 'cancelled' | 'expired' | 'failed' }
}

export function parseLogoutResult(value: unknown): { revoked: boolean } {
  if (!isObject(value) || typeof value.revoked !== 'boolean') throw new Error('退出结果格式无效')
  return { revoked: value.revoked }
}
