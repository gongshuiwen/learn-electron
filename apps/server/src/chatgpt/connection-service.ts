import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import {
  ModelError,
  type ModelErrorCode,
  type OpenAISubscription,
} from '@learn-electron/agent-runtime'
import type { ChatGPTLogin, ChatGPTModel, ChatGPTState } from '@learn-electron/contracts/chatgpt'
import { HttpError } from '../errors.ts'
import { CHATGPT_SCOPE, ChatGPTOAuth, OAuthError, PLAN_SCOPE } from './oauth.ts'
import { ConnectionStorage, type SavedConnections, type SavedProfile } from './storage.ts'

interface LoginAttempt {
  view: ChatGPTLogin
  state: string
  nonce: string
  verifier: string
  redirectUri: string
  profileId: string | undefined
  server: Server
  timer: ReturnType<typeof setTimeout>
  consumed: boolean
}

const terminalRefreshErrors = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
])

function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error('操作已取消'))
    signal.addEventListener('abort', abort, { once: true })
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** One data-directory owner, one refresh/write queue, one active connection. */
export class ChatGPTConnectionService implements OpenAISubscription {
  private attempt?: LoginAttempt
  private tail: Promise<unknown> = Promise.resolve()
  private changing = false
  private closed = false
  private unpersisted = false
  private readonly supported: Set<string>

  private constructor(
    private state: SavedConnections,
    private readonly storage: ConnectionStorage,
    private readonly oauth: ChatGPTOAuth,
    models: ChatGPTModel[],
    private readonly isBusy: () => boolean,
    private readonly preferredModel?: string,
  ) {
    this.supported = new Set(models.map((model) => model.id))
  }

  static async create(options: {
    dataDir: string
    models: ChatGPTModel[]
    isBusy: () => boolean
    oauth?: ChatGPTOAuth | undefined
    model?: string | undefined
  }): Promise<ChatGPTConnectionService> {
    const storage = new ConnectionStorage(options.dataDir)
    return new ChatGPTConnectionService(
      await storage.load(),
      storage,
      options.oauth ?? new ChatGPTOAuth(),
      options.models,
      options.isBusy,
      options.model,
    )
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    return result
  }

  private async commit(next: SavedConnections): Promise<void> {
    await this.storage.save(next)
    this.state = next
    this.unpersisted = false
  }

  private active(): SavedProfile | undefined {
    return this.state.profiles.find((profile) => profile.id === this.state.activeId)
  }

  private profile(id: string): SavedProfile {
    const profile = this.state.profiles.find((item) => item.id === id)
    if (!profile) throw new HttpError(404, 'connection_not_found', '模型连接不存在')
    return profile
  }

  private async change<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new HttpError(503, 'shutting_down', '服务正在停止')
    if (this.changing || this.isBusy())
      throw new HttpError(409, 'connection_busy', '请先停止生成，再更改模型连接')
    this.changing = true
    try {
      return await this.enqueue(operation)
    } finally {
      this.changing = false
    }
  }

  status(): ChatGPTState {
    return {
      enabled: true,
      activeId: this.state.activeId,
      ...(this.attempt?.view.status === 'pending'
        ? { pendingLogin: { ...this.attempt.view } }
        : {}),
      profiles: this.state.profiles.map((profile) => ({
        id: profile.id,
        label: profile.email ?? (profile.subject ? 'ChatGPT 账户' : '未完成的连接'),
        status: profile.reauth ? 'reauth_required' : profile.tokens ? 'connected' : 'signed_out',
        planUsage: Boolean(profile.tokens?.scopes.includes(PLAN_SCOPE)),
        modelId: profile.modelId ?? null,
      })),
    }
  }

  snapshot(): ReturnType<OpenAISubscription['snapshot']> {
    const profile = this.active()
    if (
      this.closed ||
      this.changing ||
      this.attempt?.view.status === 'pending' ||
      !profile?.tokens ||
      !profile.tokens.scopes.includes(PLAN_SCOPE) ||
      !profile.modelId ||
      !this.supported.has(profile.modelId) ||
      !profile.models.some((model) => model.id === profile.modelId)
    )
      return undefined
    return { connectionId: profile.id, modelId: profile.modelId }
  }

  async beginLogin(profileId?: string, timeoutMs = 900_000): Promise<ChatGPTLogin> {
    return this.change(async () => {
      if (this.attempt?.view.status === 'pending')
        throw new HttpError(409, 'login_pending', '已有登录正在进行')
      const profile = profileId ? this.profile(profileId) : undefined
      const state = randomBytes(32).toString('base64url')
      const nonce = randomBytes(32).toString('base64url')
      const verifier = randomBytes(32).toString('base64url')
      const server = createServer(
        { requestTimeout: 10_000, headersTimeout: 5000 },
        (request, response) => {
          const attempt = this.attempt
          let url: URL
          try {
            url = new URL(request.url ?? '/', 'http://127.0.0.1')
          } catch {
            response.writeHead(400)
            response.end()
            return
          }
          const valid =
            attempt?.server === server &&
            request.method === 'GET' &&
            request.headers.host === new URL(attempt.redirectUri).host &&
            url.pathname === '/auth/callback' &&
            url.searchParams.get('state') === attempt.state &&
            attempt.view.status === 'pending' &&
            !attempt.consumed
          response.writeHead(valid ? 200 : 400, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
          })
          response.end(
            valid
              ? '<p>正在完成 ChatGPT 授权，请返回应用查看结果。</p>'
              : '<p>授权响应无效，请返回应用重新登录。</p>',
          )
          if (valid) {
            attempt.consumed = true
            void this.enqueue(() => this.complete(attempt, url.searchParams))
              .catch((error: unknown) => {
                if (attempt.view.status === 'pending') {
                  attempt.view.status = 'failed'
                  attempt.view.error =
                    error instanceof OAuthError && error.code === 'consent_declined'
                      ? '未完成 ChatGPT 授权，你可以重新登录。'
                      : error instanceof OAuthError &&
                          error.code === 'unsupported_country_region_territory'
                        ? 'OpenAI 拒绝了当前地区的授权请求（unsupported_country_region_territory），连接未完成。请确认运行环境符合官方支持范围。'
                        : error instanceof OAuthError && error.status === 403
                          ? 'ChatGPT 授权请求被拒绝（403），请检查账户、工作区或网络访问限制。'
                          : 'ChatGPT 登录失败，请检查网络或重新授权。'
                }
              })
              .finally(() => this.release(attempt))
          }
        },
      )
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('无法启动 OAuth 回调')
      const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
      const params = new URLSearchParams({
        client_id: profile?.clientId ?? 'dynamic_agent_client',
        ext_agent_host_id: this.state.hostId,
        response_type: 'code',
        redirect_uri: redirectUri,
        resource: this.oauth.resource,
        scope: CHATGPT_SCOPE,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      })
      if (!profile) params.set('agent_name_hint', 'Pi Chat')
      if (profile?.tokens && !profile.tokens.scopes.includes(PLAN_SCOPE))
        params.set('prompt', 'consent')
      // Retained ID tokens stay in the backend; do not put id_token_hint in a renderer-visible URL.
      const view: ChatGPTLogin = {
        id: randomUUID(),
        status: 'pending',
        authorizationUrl: this.oauth.authorization(params),
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      }
      const attempt: LoginAttempt = {
        view,
        state,
        nonce,
        verifier,
        redirectUri,
        profileId,
        server,
        consumed: false,
        timer: setTimeout(() => {
          if (view.status === 'pending') {
            view.status = 'expired'
            this.release(attempt)
          }
        }, timeoutMs),
      }
      attempt.timer.unref()
      this.attempt = attempt
      return { ...view }
    })
  }

  login(id: string): ChatGPTLogin {
    if (this.attempt?.view.id !== id)
      throw new HttpError(404, 'login_not_found', '登录请求不存在，请重新登录')
    return { ...this.attempt.view }
  }

  cancelLogin(id: string): void {
    this.login(id)
    const attempt = this.attempt!
    if (attempt.view.status === 'pending') attempt.view.status = 'cancelled'
    this.release(attempt)
  }

  private release(attempt: LoginAttempt): void {
    clearTimeout(attempt.timer)
    attempt.server.close()
    attempt.server.closeAllConnections()
  }

  private async complete(attempt: LoginAttempt, params: URLSearchParams): Promise<void> {
    if (attempt.view.status !== 'pending' || this.closed) return
    if (params.has('error')) throw new OAuthError('consent_declined')
    const code = params.get('code')
    const existing = attempt.profileId ? this.profile(attempt.profileId) : undefined
    const clientId = params.get('client_id') ?? existing?.clientId
    if (
      !code ||
      !clientId ||
      clientId === 'dynamic_agent_client' ||
      !/^[\w-]{1,200}$/.test(clientId) ||
      (existing && clientId !== existing.clientId)
    )
      throw new OAuthError('invalid_callback')
    if (!existing) {
      const next = structuredClone(this.state)
      const registration = { id: randomUUID(), clientId, models: [] }
      next.profiles.push(registration)
      attempt.profileId = registration.id
      // Keep the issued client ID even when code exchange or identity validation fails.
      await this.commit(next)
    }
    if (attempt.view.status !== 'pending' || this.closed) return
    const tokens = await this.oauth.token(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: attempt.verifier,
        redirect_uri: attempt.redirectUri,
      }),
    )
    try {
      if (attempt.view.status !== 'pending' || this.closed) return
      if (!tokens.idToken) throw new OAuthError('invalid_identity')
      const identity = await this.oauth.identity(tokens.idToken, clientId, attempt.nonce)
      if (existing?.subject && identity.subject !== existing.subject)
        throw new OAuthError('identity_changed')
      const before = this.state
      const next = structuredClone(before)
      const profile = next.profiles.find((item) => item.id === attempt.profileId)!
      Object.assign(profile, identity, { tokens, reauth: false })
      profile.models = tokens.scopes.includes(PLAN_SCOPE)
        ? await this.catalog(tokens.accessToken).catch(() => [])
        : []
      const selected = this.preferredModel ?? profile.models[0]?.id
      if (!profile.modelId && selected) profile.modelId = selected
      next.activeId = profile.id
      if (attempt.view.status !== 'pending' || this.closed) return
      await this.storage.save(next)
      if (attempt.view.status !== 'pending' || this.closed) {
        await this.storage.save(before)
        return
      }
      this.state = next
      attempt.view.status = 'completed'
    } finally {
      if (attempt.view.status !== 'completed' && tokens.refreshToken)
        await this.oauth.revoke(clientId, tokens.refreshToken).catch(() => {})
    }
  }

  private async catalog(token: string): Promise<ChatGPTModel[]> {
    return (await this.oauth.models(token)).filter((model) => this.supported.has(model.id))
  }

  async models(refresh = false): Promise<ChatGPTModel[]> {
    const profile = this.active()
    if (!profile?.tokens?.scopes.includes(PLAN_SCOPE)) return []
    if (!refresh && profile.models.length) return [...profile.models]
    return this.change(async () => {
      const token = await this.resolveToken(profile.id)
      const models = await this.catalog(token)
      const next = structuredClone(this.state)
      const saved = next.profiles.find((item) => item.id === profile.id)!
      saved.models = models
      const selected = this.preferredModel ?? models[0]?.id
      if (!saved.modelId && selected) saved.modelId = selected
      await this.commit(next)
      return models
    })
  }

  async select(profileId: string): Promise<void> {
    await this.change(async () => {
      this.profile(profileId)
      if (this.attempt?.view.status === 'pending')
        throw new HttpError(409, 'login_pending', '请先取消当前登录')
      const next = structuredClone(this.state)
      next.activeId = profileId
      await this.commit(next)
    })
  }

  async selectModel(modelId: string): Promise<void> {
    await this.change(async () => {
      const profile = this.active()
      if (!profile?.models.some((model) => model.id === modelId) || !this.supported.has(modelId))
        throw new HttpError(400, 'model_unavailable', '请选择当前连接可用的模型')
      const next = structuredClone(this.state)
      next.profiles.find((item) => item.id === profile.id)!.modelId = modelId
      await this.commit(next)
    })
  }

  token(connectionId: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (this.closed || this.changing) return Promise.reject(new ModelError('auth_required'))
    // Cancellation stops only the caller's wait; an issued replacement must still be saved.
    return waitFor(
      this.enqueue(() => this.resolveToken(connectionId)),
      signal,
    )
  }

  private async resolveToken(connectionId: string): Promise<string> {
    // A token may have rotated before a disk error. Retry its save, never reuse the old refresh token.
    if (this.unpersisted) await this.commit(this.state)
    const profile = this.active()
    if (profile?.id !== connectionId) throw new ModelError('connection_changed')
    const tokens = profile.tokens
    if (!tokens || profile.reauth) throw new ModelError('auth_required')
    if (!tokens.scopes.includes(PLAN_SCOPE)) throw new ModelError('permission_missing')
    const now = Date.now()
    if (
      tokens.expiresAt > now + 60_000 ||
      (tokens.earliestRefreshAt && now < tokens.earliestRefreshAt && tokens.expiresAt > now)
    )
      return tokens.accessToken
    try {
      if (!tokens.refreshToken) throw new OAuthError('invalid_refresh_token')
      const replacement = await this.oauth.token(
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: profile.clientId,
          refresh_token: tokens.refreshToken,
        }),
      )
      const next = structuredClone(this.state)
      next.profiles.find((item) => item.id === profile.id)!.tokens = replacement
      this.state = next
      this.unpersisted = true
      await this.commit(next)
      if (!replacement.scopes.includes(PLAN_SCOPE)) throw new ModelError('permission_missing')
      return replacement.accessToken
    } catch (error) {
      if (error instanceof OAuthError && terminalRefreshErrors.has(error.code)) {
        const next = structuredClone(this.state)
        const saved = next.profiles.find((item) => item.id === profile.id)!
        delete saved.tokens
        saved.reauth = true
        await this.commit(next)
        throw new ModelError('auth_required')
      }
      throw error instanceof ModelError
        ? error
        : new ModelError('provider_failed', { cause: error })
    }
  }

  async failed(code: ModelErrorCode): Promise<void> {
    if (code !== 'auth_required' && code !== 'permission_missing') return
    await this.enqueue(async () => {
      const profile = this.active()
      if (!profile) return
      const next = structuredClone(this.state)
      const saved = next.profiles.find((item) => item.id === profile.id)!
      if (code === 'auth_required') {
        delete saved.tokens
        saved.reauth = true
      } else if (saved.tokens)
        saved.tokens.scopes = saved.tokens.scopes.filter((scope) => scope !== PLAN_SCOPE)
      await this.commit(next)
    })
  }

  async logout(stop: () => Promise<void>): Promise<{ revoked: boolean }> {
    if (this.closed || this.changing)
      throw new HttpError(409, 'connection_busy', '模型连接正在更新')
    this.changing = true
    if (this.attempt?.view.status === 'pending') this.cancelLogin(this.attempt.view.id)
    try {
      await stop()
      return await this.enqueue(async () => {
        const profile = this.active()
        let revoked = true
        if (profile?.tokens?.refreshToken) {
          try {
            await this.oauth.revoke(profile.clientId, profile.tokens.refreshToken)
          } catch {
            revoked = false
          }
        }
        if (profile) {
          const next = structuredClone(this.state)
          const saved = next.profiles.find((item) => item.id === profile.id)!
          delete saved.tokens
          delete saved.reauth
          await this.commit(next)
        }
        return { revoked }
      })
    } finally {
      this.changing = false
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.attempt?.view.status === 'pending') this.cancelLogin(this.attempt.view.id)
    await this.tail
    if (this.unpersisted) await this.commit(this.state)
  }
}
