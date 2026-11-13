import { parseSchema } from './validation.ts'
import type { ChatGPTLogin, ChatGPTModel, ChatGPTProfile, LogoutResult } from './generated/types.ts'

export type { ChatGPTLogin, ChatGPTModel, ChatGPTProfile, LogoutResult } from './generated/types.ts'

export function parseChatGPTProfile(value: unknown): ChatGPTProfile {
  const profile = parseSchema('ChatGPTProfile', value, 'ChatGPT 连接状态格式无效')
  return {
    id: profile.id,
    name: profile.name,
    status: profile.status,
    planUsage: profile.planUsage,
  }
}

export function parseChatGPTModels(value: unknown): ChatGPTModel[] {
  return parseSchema('ChatGPTModels', value, '模型目录格式无效')
}

export function parseChatGPTLogin(value: unknown): ChatGPTLogin {
  const login = parseSchema('ChatGPTLogin', value, '登录进度格式无效')
  const details = {
    id: login.id,
    authorizationUrl: login.authorizationUrl,
    expiresAt: login.expiresAt,
    ...(login.error !== undefined ? { error: login.error } : {}),
  }
  return login.status === 'completed'
    ? { ...details, status: 'completed', instanceId: login.instanceId }
    : { ...details, status: login.status }
}

export function parseLogoutResult(value: unknown): LogoutResult {
  const result = parseSchema('LogoutResult', value, '退出结果格式无效')
  return { revoked: result.revoked }
}
