import type { Tokens } from './oauth.ts'

export interface ChatGPTModel {
  id: string
  name: string
}

export interface ChatGPTProfile {
  id: string
  name: string
  status: 'signed_out' | 'connected' | 'reauth_required' | 'authorizing' | 'busy'
  planUsage: boolean
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

export interface SavedProfile {
  id: string
  clientId?: string
  subject?: string
  email?: string
  tokens?: Tokens
  reauth?: boolean
  models: ChatGPTModel[]
}

export interface SavedConnections {
  version: 2
  hostId: string
  profiles: SavedProfile[]
}

export interface AccountStorage {
  load(): Promise<SavedConnections>
  save(state: SavedConnections): Promise<void>
}

export type AuthErrorCode =
  | 'auth_required'
  | 'permission_missing'
  | 'provider_failed'
  | 'model_unavailable'
  | 'connection_not_found'
  | 'connection_busy'
  | 'shutting_down'
  | 'authorization_active'
  | 'login_pending'
  | 'login_not_found'

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string = code,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
