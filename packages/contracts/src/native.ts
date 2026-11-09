export type ThemeSource = 'system' | 'light' | 'dark'

export function isThemeSource(value: unknown): value is ThemeSource {
  return value === 'system' || value === 'light' || value === 'dark'
}

/** Native capabilities used by the shared UI; no Electron runtime types. */
export interface NativeBridge {
  readonly apiBaseUrl: string
  getTheme: () => Promise<ThemeSource>
  setTheme: (source: ThemeSource) => Promise<ThemeSource>
  openChatGPTUrl: (url: string) => Promise<void>
}

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'

/** Only the two ChatGPT destinations used by the UI may leave the app. */
export function isChatGPTUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
      return false
    if (url.href === CHATGPT_USAGE_URL) return true
    if (url.hostname !== 'auth.openai.com' || url.pathname !== '/api/accounts/authorize')
      return false
    for (const key of ['access_token', 'refresh_token', 'id_token_hint'])
      if (url.searchParams.has(key)) return false
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
    return (
      redirect.protocol === 'http:' &&
      redirect.hostname === '127.0.0.1' &&
      Boolean(redirect.port) &&
      redirect.pathname === '/auth/callback' &&
      !redirect.username &&
      !redirect.password &&
      !redirect.search &&
      !redirect.hash &&
      url.searchParams.get('response_type') === 'code' &&
      url.searchParams.get('code_challenge_method') === 'S256' &&
      ['client_id', 'state', 'nonce', 'code_challenge'].every((key) =>
        Boolean(url.searchParams.get(key)),
      )
    )
  } catch {
    return false
  }
}
