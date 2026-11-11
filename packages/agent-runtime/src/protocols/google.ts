import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import {
  isObject,
  parseModelDefinition,
  type ConnectionConfig,
  type RequestCredentials,
} from '@learn-electron/model-connections'
import { catalog, catalogModels, unchangedBaseUrl } from './shared.ts'

export const google = {
  api: 'google-generative-ai' as const,
  create: googleGenerativeAIApi,
  baseUrl: unchangedBaseUrl,
  async discover(config: ConnectionConfig, credentials: RequestCredentials, signal: AbortSignal) {
    const body = await catalog(
      `${config.baseUrl}/models`,
      credentials,
      credentials.apiKey ? { 'x-goog-api-key': credentials.apiKey } : {},
      signal,
    )
    const entries = Array.isArray(body.models)
      ? body.models.filter(
          (item) =>
            isObject(item) &&
            (!Array.isArray(item.supportedGenerationMethods) ||
              item.supportedGenerationMethods.includes('generateContent')),
        )
      : body.models
    return catalogModels(entries, (item) => {
      const id = typeof item.name === 'string' ? item.name.replace(/^models\//, '') : item.id
      return parseModelDefinition({
        id,
        name: item.displayName ?? id,
        ...(typeof item.inputTokenLimit === 'number'
          ? { contextWindow: item.inputTokenLimit }
          : {}),
        ...(typeof item.outputTokenLimit === 'number'
          ? { maxOutputTokens: item.outputTokenLimit }
          : {}),
      })
    })
  },
}
