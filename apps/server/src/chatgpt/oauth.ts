import { createRemoteJWKSet, jwtVerify } from 'jose'
import { isRecord } from '@learn-electron/contracts'
import type { ChatGPTModel } from '@learn-electron/contracts/chatgpt'

export const CHATGPT_SCOPE =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct'

export interface Tokens {
  accessToken: string
  refreshToken?: string
  idToken?: string
  expiresAt: number
  scopes: string[]
  earliestRefreshAt?: number
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly requestId?: string | null,
  ) {
    super('ChatGPT 授权服务暂不可用，请稍后重试。')
  }
}

/** OAuth/OIDC wire protocol only. Storage and active-account policy live in ConnectionService. */
export class ChatGPTOAuth {
  readonly issuer: string
  readonly resource: string
  private metadata: Promise<Record<string, unknown>> | undefined
  private keys?: ReturnType<typeof createRemoteJWKSet>

  constructor(options: { issuer?: string; resource?: string } = {}) {
    this.issuer = options.issuer ?? 'https://auth.openai.com'
    this.resource = options.resource ?? 'https://api.openai.com/v1'
  }

  authorization(params: URLSearchParams): string {
    const url = new URL('/api/accounts/authorize', this.issuer)
    url.search = params.toString()
    return url.href
  }

  private async discovery(): Promise<Record<string, unknown>> {
    this.metadata ??= (async () => {
      const data = await this.json(`${this.issuer}/.well-known/openid-configuration`)
      if (data.issuer !== this.issuer) throw new OAuthError('invalid_issuer')
      return data
    })().catch((error: unknown) => {
      this.metadata = undefined
      throw error
    })
    return this.metadata
  }

  private endpoint(metadata: Record<string, unknown>, name: string): URL {
    if (typeof metadata[name] !== 'string') throw new OAuthError('invalid_metadata')
    const url = new URL(metadata[name])
    const local = new URL(this.issuer)
    if (
      url.protocol !== 'https:' &&
      !(local.hostname === '127.0.0.1' && url.origin === local.origin)
    )
      throw new OAuthError('invalid_metadata')
    return url
  }

  private async json(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: init?.signal ?? AbortSignal.timeout(15_000),
    })
    const data: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const code =
        isRecord(data) && typeof data.error === 'string'
          ? data.error
          : isRecord(data) && isRecord(data.error) && typeof data.error.code === 'string'
            ? data.error.code
            : 'oauth_unavailable'
      throw new OAuthError(code, response.status, response.headers.get('x-request-id'))
    }
    if (!isRecord(data)) throw new OAuthError('invalid_response')
    return data
  }

  async token(form: URLSearchParams): Promise<Tokens> {
    form.set('resource', this.resource)
    const data = await this.json(`${this.issuer}/api/accounts/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    })
    if (
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      typeof data.expires_in !== 'number' ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    )
      throw new OAuthError('invalid_token_response')
    return {
      accessToken: data.access_token,
      ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : {}),
      ...(typeof data.id_token === 'string' ? { idToken: data.id_token } : {}),
      expiresAt: Date.now() + data.expires_in * 1000,
      scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : [],
      ...(typeof data.earliest_refresh_at === 'number'
        ? { earliestRefreshAt: data.earliest_refresh_at * 1000 }
        : {}),
    }
  }

  async identity(
    idToken: string,
    clientId: string,
    nonce: string,
  ): Promise<{ subject: string; email?: string }> {
    const metadata = await this.discovery()
    this.keys ??= createRemoteJWKSet(this.endpoint(metadata, 'jwks_uri'), {
      timeoutDuration: 10_000,
    })
    const { payload } = await jwtVerify(idToken, this.keys, {
      issuer: this.issuer,
      audience: clientId,
      algorithms: ['RS256', 'ES256'],
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
      clockTolerance: 5,
    })
    if (!payload.sub || payload.nonce !== nonce) throw new OAuthError('invalid_identity')
    return {
      subject: payload.sub,
      ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
    }
  }

  async models(accessToken: string): Promise<ChatGPTModel[]> {
    const data = await this.json(`${this.resource}/models`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!Array.isArray(data.models)) throw new OAuthError('invalid_models')
    const models: unknown[] = data.models
    return models.flatMap((model) =>
      isRecord(model) &&
      model.visibility === 'list' &&
      typeof model.slug === 'string' &&
      typeof model.display_name === 'string'
        ? [{ id: model.slug, name: model.display_name }]
        : [],
    )
  }

  async revoke(clientId: string, refreshToken: string): Promise<void> {
    const url = this.endpoint(await this.discovery(), 'revocation_endpoint')
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }),
    })
    if (!response.ok) throw new OAuthError('revocation_failed', response.status)
  }
}
