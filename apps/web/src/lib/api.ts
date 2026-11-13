import { API_PREFIX, parseApiError, type ApiError } from '@learn-electron/contracts'
import { platform } from '@/platform'

export const apiBase = `${platform.apiBaseUrl}${API_PREFIX}`

export class ProtocolError extends Error {}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiError['error']['code'] | undefined,
    message: string,
  ) {
    super(message)
  }

  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500
  }
}

export async function readRequestError(response: Response): Promise<ApiRequestError> {
  let message = `请求失败（${response.status}）`
  let code: string | undefined
  try {
    const body: unknown = await response.json()
    const parsed = parseApiError(body)
    message = parsed.error.message
    code = parsed.error.code
  } catch {
    // Proxies can return HTML or JSON that does not satisfy the API error contract.
  }
  return new ApiRequestError(response.status, code, message)
}

export function request(path: string, decode: undefined, init?: RequestInit): Promise<void>
export function request<T>(
  path: string,
  decode: (value: unknown) => T,
  init?: RequestInit,
): Promise<T>
export async function request<T>(
  path: string,
  decode: ((value: unknown) => T) | undefined,
  init: RequestInit = {},
): Promise<T | void> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  })
  if (!response.ok) throw await readRequestError(response)
  if (!decode) {
    if (response.status !== 204) throw new ProtocolError('服务端响应格式不兼容，请刷新页面。')
    return
  }
  try {
    const value: unknown = await response.json()
    return decode(value)
  } catch (cause) {
    if (init.signal?.aborted) throw cause
    throw new ProtocolError(
      cause instanceof SyntaxError
        ? '服务端响应不是有效 JSON，请刷新页面。'
        : cause instanceof Error
          ? cause.message
          : '服务端响应格式不兼容，请刷新页面。',
      { cause },
    )
  }
}
