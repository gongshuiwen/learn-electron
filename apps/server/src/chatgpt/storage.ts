import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isRecord } from '@learn-electron/contracts'
import { parseChatGPTModels } from '@learn-electron/contracts/chatgpt'
import type { SavedConnections, Tokens } from '@learn-electron/chatgpt-auth'
import { ProtectedFile } from '../shared/index.ts'

function validTokens(value: unknown): value is Tokens {
  return (
    isRecord(value) &&
    typeof value.accessToken === 'string' &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === 'string') &&
    ['refreshToken', 'idToken'].every(
      (key) => value[key] === undefined || typeof value[key] === 'string',
    ) &&
    (value.earliestRefreshAt === undefined || typeof value.earliestRefreshAt === 'number')
  )
}

function decode(value: unknown): SavedConnections {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    typeof value.hostId !== 'string' ||
    !/^urn:uuid:[\da-f-]{36}$/i.test(value.hostId) ||
    !Array.isArray(value.profiles)
  )
    throw new Error('ChatGPT 凭证文件格式无效')
  for (const profile of value.profiles) {
    if (
      !isRecord(profile) ||
      typeof profile.id !== 'string' ||
      (profile.clientId !== undefined && typeof profile.clientId !== 'string') ||
      ['subject', 'email'].some(
        (key) => profile[key] !== undefined && typeof profile[key] !== 'string',
      ) ||
      (profile.reauth !== undefined && typeof profile.reauth !== 'boolean') ||
      (profile.tokens !== undefined &&
        (typeof profile.clientId !== 'string' || !validTokens(profile.tokens)))
    )
      throw new Error('ChatGPT 凭证文件格式无效')
    parseChatGPTModels(profile.models)
  }
  const state = value as unknown as SavedConnections
  if (new Set(state.profiles.map((p) => p.id)).size !== state.profiles.length)
    throw new Error('ChatGPT 凭证文件格式无效')
  return state
}

export class ConnectionStorage {
  private readonly file: ProtectedFile<SavedConnections>
  constructor(dataDir: string) {
    this.file = new ProtectedFile(join(dataDir, 'chatgpt'), 'connections.json', decode)
  }
  load(): Promise<SavedConnections> {
    return this.file.load(() => ({
      version: 2,
      hostId: `urn:uuid:${randomUUID()}`,
      profiles: [],
    }))
  }
  save(state: SavedConnections): Promise<void> {
    return this.file.save(state)
  }
}
