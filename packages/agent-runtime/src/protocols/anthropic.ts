import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import type { ConnectionConfig, RequestCredentials } from '@learn-electron/model-connections'
import { catalog, catalogModels } from './shared.ts'

export const anthropic = {
  api: 'anthropic-messages' as const,
  create: anthropicMessagesApi,
  // The SDK appends /v1/messages; discovery accepts the configured versioned base.
  baseUrl: (value: string): string => value.replace(/\/v1$/, ''),
  async discover(config: ConnectionConfig, credentials: RequestCredentials, signal: AbortSignal) {
    const path = config.baseUrl.endsWith('/v1') ? '/models' : '/v1/models'
    const body = await catalog(
      `${config.baseUrl}${path}`,
      credentials,
      {
        'anthropic-version': '2023-06-01',
        ...(credentials.apiKey ? { 'x-api-key': credentials.apiKey } : {}),
      },
      signal,
    )
    return catalogModels(body.data)
  },
}
