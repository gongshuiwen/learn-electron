import {
  AuthError,
  ChatGPTAuth,
  type ChatGPTOAuth,
  type ChatGPTModel,
} from '@learn-electron/chatgpt-auth'
import {
  ModelError,
  parseModelDefinition,
  type ModelErrorCode,
  type ModelRef,
  type ModelTarget,
} from '@learn-electron/model-connections'
import type { ProvidersState } from '@learn-electron/contracts/models'
import { HttpError } from '../errors.ts'
import type { ModelAccounts } from '../model-service.ts'
import { ConnectionStorage } from './storage.ts'

function translate(error: unknown): never {
  if (!(error instanceof AuthError)) throw error
  if (
    error.code === 'auth_required' ||
    error.code === 'permission_missing' ||
    error.code === 'provider_failed'
  )
    throw new ModelError(error.code, { cause: error })
  const status =
    error.code === 'shutting_down'
      ? 503
      : error.code === 'connection_not_found' || error.code === 'login_not_found'
        ? 404
        : error.code === 'model_unavailable'
          ? 400
          : 409
  throw new HttpError(status, error.code, error.message)
}

function attempt<T>(action: () => T): T {
  try {
    return action()
  } catch (error) {
    return translate(error)
  }
}

function attemptAsync<T>(action: () => Promise<T>): Promise<T> {
  return attempt(action).catch(translate)
}

/** Adapts account authorization to the application's model and HTTP contracts. */
export class ChatGPTProvider implements ModelAccounts {
  private readonly supported: Set<string>
  private constructor(
    private readonly auth: ChatGPTAuth,
    models: ChatGPTModel[],
    private readonly isBusy: (instanceId?: string) => boolean,
    private readonly isUpdating: (instanceId: string) => boolean,
  ) {
    this.supported = new Set(models.map(({ id }) => id))
  }

  static async create(options: {
    dataDir: string
    models: ChatGPTModel[]
    isBusy: (instanceId?: string) => boolean
    isUpdating?: (instanceId: string) => boolean
    oauth?: ChatGPTOAuth | undefined
  }): Promise<ChatGPTProvider> {
    const auth = await ChatGPTAuth.create({
      storage: new ConnectionStorage(options.dataDir),
      agentName: 'Pi Chat',
      oauth: options.oauth,
    })
    return new ChatGPTProvider(
      auth,
      options.models,
      options.isBusy,
      options.isUpdating ?? (() => false),
    )
  }

  private available(id: string): void {
    if (this.isBusy(id) || this.isUpdating(id))
      throw new HttpError(409, 'connection_busy', '请先停止生成，再更改模型连接')
  }

  status() {
    const status = this.auth.status()
    return {
      ...status,
      profiles: status.profiles.map((profile) => ({
        ...profile,
        status:
          profile.status !== 'authorizing' && this.isUpdating(profile.id)
            ? ('busy' as const)
            : profile.status,
      })),
    }
  }

  view(): Omit<ProvidersState, 'defaultSelection'> {
    const status = this.status()
    return {
      instances: status.profiles.map((profile) => ({
        ...profile,
        kind: 'chatgpt',
        vendor: 'openai',
      })),
      chatgpt: {
        enabled: true,
        ...(status.pendingLogin ? { pendingLogin: status.pendingLogin } : {}),
      },
    }
  }

  describe(id: string) {
    const profile = this.status().profiles.find((item) => item.id === id)
    return profile
      ? { provider: `ChatGPT · ${profile.name}`, authMode: 'chatgpt' as const }
      : undefined
  }

  createProfile(): Promise<string> {
    return attemptAsync(() => this.auth.createProfile())
  }
  async removeProfile(id: string, beforeRemove: () => Promise<void>): Promise<void> {
    this.available(id)
    return await attemptAsync(() => this.auth.removeProfile(id, beforeRemove))
  }
  async beginLogin(id: string, timeoutMs?: number) {
    this.available(id)
    return await attemptAsync(() => this.auth.beginLogin(id, timeoutMs))
  }
  login(id: string) {
    return attempt(() => this.auth.login(id))
  }
  cancelLogin(id: string): void {
    attempt(() => this.auth.cancelLogin(id))
  }
  async logout(id: string, stop: () => Promise<void>) {
    if (this.isUpdating(id)) throw new HttpError(409, 'connection_busy', '模型连接正在更新')
    return await attemptAsync(() => this.auth.logout(id, stop))
  }
  model(instanceId: string, modelId: string): ChatGPTModel {
    const model = attempt(() => this.auth.model(instanceId, modelId))
    if (!this.supported.has(modelId))
      throw new HttpError(400, 'model_unavailable', '请选择当前连接可用的模型')
    return model
  }
  resolve(ref: ModelRef): ModelTarget {
    return {
      instanceId: ref.instanceId,
      revision: 1,
      kind: 'chatgpt',
      provider: 'openai',
      model: parseModelDefinition(this.model(ref.instanceId, ref.modelId)),
    }
  }
  async models(id: string, refresh = false): Promise<ChatGPTModel[]> {
    const profile = this.auth.status().profiles.find((item) => item.id === id)
    if (refresh && profile?.planUsage && profile.status !== 'reauth_required') this.available(id)
    const models = await attemptAsync(() => this.auth.models(id, refresh))
    return models.filter((model) => this.supported.has(model.id))
  }
  token(id: string, signal: AbortSignal): Promise<string> {
    return attemptAsync(() => this.auth.token(id, signal))
  }
  async credentials(target: ModelTarget, signal: AbortSignal) {
    return { apiKey: await this.token(target.instanceId, signal), headers: {} }
  }
  failed(id: string, code: ModelErrorCode): Promise<void> {
    return code === 'auth_required' || code === 'permission_missing'
      ? attemptAsync(() => this.auth.failed(id, code))
      : Promise.resolve()
  }
  close(): Promise<void> {
    return attemptAsync(() => this.auth.close())
  }
}
