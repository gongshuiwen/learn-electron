import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import type { ConnectionConfig, RequestCredentials } from '@learn-electron/model-connections'
import { catalog, catalogModels, unchangedBaseUrl } from './shared.ts'

async function discover(
  config: ConnectionConfig,
  credentials: RequestCredentials,
  signal: AbortSignal,
) {
  const body = await catalog(
    `${config.baseUrl}/models`,
    credentials,
    credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {},
    signal,
  )
  return catalogModels(body.data)
}

const endpoint = { baseUrl: unchangedBaseUrl, discover }
export const openAIChat = {
  ...endpoint,
  api: 'openai-completions' as const,
  create: openAICompletionsApi,
}
export const openAIResponses = {
  ...endpoint,
  api: 'openai-responses' as const,
  create: openAIResponsesApi,
}
