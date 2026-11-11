import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  isObject,
  ModelError,
  modelRef,
  parseConnectionConfig,
  parseHeaders,
  parseIdentifier,
  parseModelDefinition,
  parseModelRef,
  parseApiKey,
  type ConnectionConfig,
  type CredentialResolver,
  type ModelDefinition,
  type ModelErrorCode,
  type ModelRef,
  type ModelTarget,
  type RequestCredentials,
} from '@learn-electron/model-connections'
import { discoverEndpointModels } from '@learn-electron/agent-runtime'
import type {
  ModelStatus,
  ProvidersState,
  SaveProviderRequest,
} from '@learn-electron/contracts/models'
import type { ChatGPTConnectionService } from './chatgpt/connection-service.ts'
import { HttpError } from './errors.ts'
import { ProtectedFile } from './protected-file.ts'

interface SavedInstance extends ConnectionConfig {
  id: string
  revision: number
  apiKey?: string
  headers: Record<string, string>
}
interface SavedState {
  version: 4
  defaultSelection: ModelRef | null
  instances: SavedInstance[]
}

function instance(value: unknown): SavedInstance {
  const config = parseConnectionConfig(value)
  if (!isObject(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
    throw new Error('已保存的模型供应商无效')
  return {
    ...config,
    id: parseIdentifier(value.id),
    revision: Number(value.revision),
    headers: parseHeaders(value.headers),
    ...(value.apiKey !== undefined ? { apiKey: parseApiKey(value.apiKey) } : {}),
  }
}

function decode(value: unknown): SavedState {
  if (!isObject(value) || value.version !== 4 || !Array.isArray(value.instances))
    throw new Error('模型供应商文件格式无效')
  const instances = value.instances.map(instance)
  if (new Set(instances.map(({ id }) => id)).size !== instances.length)
    throw new Error('模型供应商标识冲突')
  return {
    version: 4,
    defaultSelection:
      value.defaultSelection === null ? null : parseModelRef(value.defaultSelection),
    instances,
  }
}

/** Application-owned instances and model choices. Runtime receives only resolved targets and credentials. */
export class ModelService implements CredentialResolver {
  private readonly changing = new Set<string>()
  private closed = false
  private tail: Promise<unknown> = Promise.resolve()
  private readonly shutdown = new AbortController()
  private constructor(
    private state: SavedState,
    private readonly file: ProtectedFile<SavedState>,
    private readonly chatgpt: ChatGPTConnectionService,
    private readonly isBusy: (instanceId: string) => boolean,
  ) {}

  static async create(
    dataDir: string,
    chatgpt: ChatGPTConnectionService,
    isBusy: (instanceId: string) => boolean,
  ): Promise<ModelService> {
    const file = new ProtectedFile<SavedState>(join(dataDir, 'models'), 'connections.json', decode)
    const state = await file.load(() => ({
      version: 4,
      defaultSelection: null,
      instances: [],
    }))
    const ids = [
      ...state.instances.map(({ id }) => id),
      ...chatgpt.status().profiles.map(({ id }) => id),
    ]
    if (new Set(ids).size !== ids.length) throw new Error('模型供应商标识冲突')
    return new ModelService(state, file, chatgpt, isBusy)
  }

  private change<T>(operation: () => Promise<T>, instanceId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new HttpError(503, 'shutting_down', '服务正在停止'))
    if (instanceId && (this.changing.has(instanceId) || this.isBusy(instanceId)))
      return Promise.reject(
        new HttpError(409, 'connection_busy', '该供应商实例正在使用或更新，请稍后再试'),
      )
    if (instanceId) this.changing.add(instanceId)
    const result = this.tail.then(operation).finally(() => {
      if (instanceId) this.changing.delete(instanceId)
    })
    this.tail = result.catch(() => {})
    return result
  }
  private async commit(next: SavedState): Promise<void> {
    await this.file.save(next)
    this.state = next
  }
  private endpoint(id: string): SavedInstance {
    const entry = this.state.instances.find((item) => item.id === id)
    if (!entry) throw new HttpError(404, 'provider_not_found', '模型供应商实例不存在')
    return entry
  }
  defaultSelection(): ModelRef | null {
    return structuredClone(this.state.defaultSelection)
  }
  isChanging(instanceId: string): boolean {
    return this.changing.has(instanceId)
  }
  status(): ProvidersState {
    const accounts = this.chatgpt.status()
    return {
      defaultSelection: this.defaultSelection(),
      instances: [
        ...this.state.instances.map(({ apiKey, headers, ...entry }) => ({
          ...structuredClone(entry),
          kind: 'endpoint' as const,
          hasCredential: Boolean(apiKey),
          hasHeaders: Object.keys(headers).length > 0,
        })),
        ...accounts.profiles.map((profile) => ({
          ...profile,
          kind: 'chatgpt' as const,
          vendor: 'openai' as const,
        })),
      ],
      chatgpt: {
        enabled: true,
        ...(accounts.pendingLogin ? { pendingLogin: accounts.pendingLogin } : {}),
      },
    }
  }
  resolve(selection: ModelRef): ModelTarget {
    return this.target(selection)
  }

  statusFor(selection: ModelRef | null, binding?: ModelRef): ModelStatus {
    let ref = binding
    try {
      if (!ref && selection) ref = selection
      if (!ref)
        return {
          selection,
          target: null,
          model: { provider: 'unconfigured', id: 'unconfigured' },
          configured: false,
          reason: 'not_selected',
        }
      const target = this.target(ref)
      const account =
        target.kind === 'chatgpt'
          ? this.chatgpt.status().profiles.find(({ id }) => id === target.instanceId)
          : undefined
      return {
        selection,
        target: modelRef(target),
        model: {
          provider: account ? `ChatGPT · ${account.name}` : target.provider,
          id: target.model.id,
        },
        configured: true,
        ...(target.kind === 'chatgpt' ? { authMode: 'chatgpt' } : {}),
      }
    } catch (error) {
      if (!(error instanceof ModelError || error instanceof HttpError)) throw error
      const instanceId = ref?.instanceId
      const account = this.chatgpt.status().profiles.find(({ id }) => id === instanceId)
      const endpoint = this.state.instances.find(({ id }) => id === instanceId)
      return {
        selection,
        target: ref ?? null,
        model: {
          provider: endpoint?.name ?? (account ? `ChatGPT · ${account.name}` : 'unconfigured'),
          id: ref?.modelId ?? 'unconfigured',
        },
        configured: false,
        reason: error.code,
        ...(account ? { authMode: 'chatgpt' } : {}),
      }
    }
  }

  private target(ref: ModelRef): ModelTarget {
    if (this.closed) throw new HttpError(503, 'shutting_down', '服务正在停止')
    if (this.changing.has(ref.instanceId))
      throw new HttpError(409, 'connection_busy', '该供应商实例正在更新')
    const entry = this.state.instances.find(({ id }) => id === ref.instanceId)
    if (!entry)
      return {
        instanceId: ref.instanceId,
        revision: 1,
        kind: 'chatgpt',
        provider: 'openai',
        model: parseModelDefinition(this.chatgpt.model(ref.instanceId, ref.modelId)),
      }
    this.endpointCredentials(entry)
    const model = entry.models.find(({ id }) => id === ref.modelId)
    if (!model) throw new HttpError(400, 'model_unavailable', '该实例未配置此模型')
    return {
      instanceId: entry.id,
      revision: entry.revision,
      kind: 'endpoint',
      provider: entry.name,
      protocol: entry.protocol,
      baseUrl: entry.baseUrl,
      authentication: entry.authentication,
      model: structuredClone(model),
      compatibility: { ...entry.compatibility },
    }
  }
  private endpointCredentials(entry: SavedInstance): RequestCredentials {
    if (entry.authentication === 'api-key' && !entry.apiKey) throw new ModelError('auth_required')
    return {
      ...(entry.authentication === 'api-key' && entry.apiKey ? { apiKey: entry.apiKey } : {}),
      headers: { ...entry.headers },
    }
  }
  async credentials(target: ModelTarget, signal: AbortSignal): Promise<RequestCredentials> {
    signal.throwIfAborted()
    if (this.closed) throw new ModelError('auth_required')
    if (target.kind === 'chatgpt')
      return { apiKey: await this.chatgpt.token(target.instanceId, signal), headers: {} }
    const entry = this.endpoint(target.instanceId)
    if (entry.revision !== target.revision) throw new ModelError('connection_changed')
    return this.endpointCredentials(entry)
  }
  failed(target: ModelTarget, code: ModelErrorCode): Promise<void> {
    return target.kind === 'chatgpt'
      ? this.chatgpt.failed(target.instanceId, code)
      : Promise.resolve()
  }

  save(request: SaveProviderRequest, id?: string): Promise<ProvidersState> {
    return this.change(async () => {
      const existing = id ? this.endpoint(id) : undefined
      if (
        existing &&
        (existing.baseUrl !== request.baseUrl || existing.protocol !== request.protocol)
      )
        throw new HttpError(
          409,
          'connection_identity_changed',
          '地址或协议变更请添加新实例，以保留会话归属',
        )
      const config = parseConnectionConfig(request)
      const entry: SavedInstance = {
        ...config,
        id: existing?.id ?? randomUUID(),
        revision: (existing?.revision ?? 0) + 1,
        headers: request.headers ?? existing?.headers ?? {},
      }
      const key = request.apiKey === undefined ? existing?.apiKey : request.apiKey
      if (key && config.authentication === 'api-key') entry.apiKey = key
      const next = structuredClone(this.state)
      if (existing)
        next.instances[next.instances.findIndex((item) => item.id === existing.id)] = entry
      else next.instances.push(entry)
      await this.commit(next)
      return this.status()
    }, id)
  }
  remove(id: string): Promise<ProvidersState> {
    const endpoint = this.state.instances.some((item) => item.id === id)
    return this.change(
      async () => {
        const next = structuredClone(this.state)
        next.instances = next.instances.filter((item) => item.id !== id)
        if (next.defaultSelection?.instanceId === id) next.defaultSelection = null
        if (endpoint) await this.commit(next)
        else await this.chatgpt.removeProfile(id, () => this.commit(next))
        return this.status()
      },
      endpoint ? id : undefined,
    )
  }
  createChatGPT(): Promise<ProvidersState> {
    return this.change(async () => {
      await this.chatgpt.createProfile()
      return this.status()
    })
  }
  select(selection: ModelRef): Promise<ProvidersState> {
    return this.change(async () => {
      this.resolve(selection)
      await this.commit({ ...this.state, defaultSelection: structuredClone(selection) })
      return this.status()
    })
  }
  models(id: string): Promise<ModelDefinition[]> {
    const entry = this.state.instances.find((item) => item.id === id)
    return entry
      ? Promise.resolve(structuredClone(entry.models))
      : this.chatgpt.models(id).then((items) => items.map(parseModelDefinition))
  }
  refreshModels(id: string): Promise<ModelDefinition[]> {
    if (this.closed) return Promise.reject(new HttpError(503, 'shutting_down', '服务正在停止'))
    const entry = this.state.instances.find((item) => item.id === id)
    if (!entry)
      return this.chatgpt.models(id, true).then((items) => items.map(parseModelDefinition))
    return this.change(async () => {
      const models = await discoverEndpointModels(
        entry,
        this.endpointCredentials(entry),
        AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(15_000)]),
      )
      const next = structuredClone(this.state)
      const saved = next.instances.find((item) => item.id === id)!
      const merged = new Map(entry.models.map((model) => [model.id, model]))
      for (const model of models) if (!merged.has(model.id)) merged.set(model.id, model)
      saved.models = [...merged.values()].slice(0, 200)
      saved.revision++
      await this.commit(next)
      return structuredClone(saved.models)
    }, id)
  }
  test(
    id: string,
    modelId: string,
    execute: (target: ModelTarget, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    // Target resolution runs before the instance is marked as updating.
    const target = this.target({ instanceId: id, modelId })
    return this.change(
      () => execute(target, AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(15_000)])),
      id,
    )
  }
  async close(): Promise<void> {
    this.closed = true
    this.shutdown.abort()
    const results = await Promise.allSettled([this.tail, this.chatgpt.close()])
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
}
