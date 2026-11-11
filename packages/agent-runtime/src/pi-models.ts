import {
  createProvider,
  InMemoryCredentialStore,
  type Model,
  type Api,
} from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import {
  ModelError,
  type ModelTarget,
  type CredentialResolver,
} from '@learn-electron/model-connections'
import { protocolAdapters } from './protocols/index.ts'
export { modelFailure } from './protocols/shared.ts'

/** The only translation from the app's connection vocabulary to Pi model/provider types. */
export async function createModelRuntime(target: ModelTarget, connections: CredentialResolver) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  })
  const auth = {
    apiKey: {
      name: 'Application connection',
      check: () => Promise.resolve({ type: 'api_key' as const, source: 'Application connection' }),
      async resolve({ signal }: { signal: AbortSignal }) {
        const credentials = await connections.credentials(target, signal)
        return {
          auth: {
            // The SDK requires a nonempty value even for keyless local servers. Null headers
            // remove its generated Authorization header; no placeholder reaches the endpoint.
            apiKey: credentials.apiKey ?? 'unused',
            headers: {
              ...(target.kind === 'endpoint' && target.authentication === 'none'
                ? { Authorization: null }
                : {}),
              ...credentials.headers,
            },
          },
          source: 'Application connection',
        }
      },
    },
  }
  if (target.kind === 'chatgpt') {
    const provider = openaiProvider()
    runtime.registerNativeProvider({ ...provider, getAllModels: () => provider.getModels(), auth })
    const model = runtime.getPhysicalModel('openai', target.model.id)
    if (!model) throw new ModelError('model_unavailable')
    return { runtime, model }
  }
  const adapter = protocolAdapters[target.protocol]
  const api: Api = adapter.api
  const baseUrl = adapter.baseUrl(target.baseUrl)
  const model: Model<Api> = {
    id: target.model.id,
    name: target.model.name,
    provider: target.instanceId,
    api,
    baseUrl,
    reasoning: false,
    input: ['text'],
    contextWindow: target.model.contextWindow,
    maxTokens: target.model.maxOutputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(target.protocol === 'openai-chat' ? { compat: { ...target.compatibility } } : {}),
  }
  runtime.registerNativeProvider(
    createProvider({
      id: target.instanceId,
      name: target.provider,
      baseUrl,
      models: [model],
      auth,
      api: adapter.create(),
    }),
  )
  return { runtime, model }
}
