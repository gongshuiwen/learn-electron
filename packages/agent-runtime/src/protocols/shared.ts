import {
  isObject,
  ModelError,
  parseModelDefinition,
  type ModelDefinition,
  type ModelErrorCode,
  type RequestCredentials,
} from '@learn-electron/model-connections'

export function modelFailure(detail: string): ModelErrorCode {
  if (
    /subscription_sharing_usage_limit_exceeded|usage limit|quota|\b429\b|rate.limit/i.test(detail)
  )
    return 'quota_exceeded'
  if (/chatpass_v2_scope_not_authorized|尚未获得/.test(detail)) return 'permission_missing'
  if (/subscription_sharing_invalid_user|授权已失效|invalid.api.key|\b401\b|\b403\b/i.test(detail))
    return 'auth_required'
  if (/model_not_found|model.*not.found|\b404\b/i.test(detail)) return 'model_unavailable'
  return 'provider_failed'
}

export const unchangedBaseUrl = (value: string): string => value

export async function catalog(
  url: string,
  credentials: RequestCredentials,
  defaults: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const headers = new Headers(defaults)
  for (const [name, value] of Object.entries(credentials.headers)) headers.set(name, value)
  const response = await fetch(url, { headers, signal, redirect: 'error' })
  if (!response.ok)
    throw new ModelError(
      response.status === 401 || response.status === 403
        ? 'auth_required'
        : response.status === 429
          ? 'quota_exceeded'
          : 'provider_failed',
    )
  const body: unknown = await response.json()
  if (!isObject(body)) throw new ModelError('provider_failed')
  return body
}

export function catalogModels(
  value: unknown,
  convert: (item: Record<string, unknown>) => ModelDefinition = (item) =>
    parseModelDefinition({
      id: item.id,
      name: item.display_name ?? item.name ?? item.id,
      ...(typeof item.inputTokenLimit === 'number' ? { contextWindow: item.inputTokenLimit } : {}),
      ...(typeof item.outputTokenLimit === 'number'
        ? { maxOutputTokens: item.outputTokenLimit }
        : {}),
    }),
): ModelDefinition[] {
  if (!Array.isArray(value)) throw new ModelError('provider_failed')
  return value.filter(isObject).slice(0, 200).map(convert)
}
