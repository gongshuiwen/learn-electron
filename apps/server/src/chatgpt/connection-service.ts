import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { ModelError, type ModelErrorCode } from '@learn-electron/model-connections'
import type { ChatGPTLogin, ChatGPTModel, ChatGPTProfile } from '@learn-electron/contracts/chatgpt'
import { HttpError } from '../errors.ts'
import { CHATGPT_SCOPE, ChatGPTOAuth, OAuthError, PLAN_SCOPE } from './oauth.ts'
import { ConnectionStorage, type SavedConnections, type SavedProfile } from './storage.ts'

interface LoginAttempt {
  view: ChatGPTLogin
  state: string
  nonce: string
  verifier: string
  redirectUri: string
  profileId: string
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

/** Account-scoped operations with serialized whole-file writes. */
export class ChatGPTConnectionService {
  private attempt?: LoginAttempt
  private tail: Promise<unknown> = Promise.resolve()
  private readonly accounts = new Map<string, Promise<void>>()
  private readonly changing = new Set<string>()
  private closed = false
  private startingLogin = false
  private unpersisted = false
  private readonly signingOut = new Set<string>()
  private readonly supported: Set<string>

  private constructor(
    private state: SavedConnections,
    private readonly storage: ConnectionStorage,
    private readonly oauth: ChatGPTOAuth,
    models: ChatGPTModel[],
    private readonly isBusy: (instanceId?: string) => boolean,
    private readonly isUpdating: (instanceId: string) => boolean,
  ) {
    this.supported = new Set(models.map((model) => model.id))
  }

  static async create(options: {
    dataDir: string
    models: ChatGPTModel[]
    isBusy: (instanceId?: string) => boolean
    isUpdating?: (instanceId: string) => boolean
    oauth?: ChatGPTOAuth | undefined
  }): Promise<ChatGPTConnectionService> {
    const storage = new ConnectionStorage(options.dataDir)
    return new ChatGPTConnectionService(
      await storage.load(),
      storage,
      options.oauth ?? new ChatGPTOAuth(),
      options.models,
      options.isBusy,
      options.isUpdating ?? (() => false),
    )
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    return result
  }

  private enqueueAccount<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.accounts.get(id) ?? Promise.resolve()).then(operation)
    const settled = result.then(
      () => {},
      () => {},
    )
    this.accounts.set(id, settled)
    void settled.then(() => {
      if (this.accounts.get(id) === settled) this.accounts.delete(id)
    })
    return result
  }

  private async commit(next: SavedConnections): Promise<void> {
    await this.storage.save(next)
    this.state = next
    this.unpersisted = false
  }

  private profile(id: string): SavedProfile {
    const profile = this.state.profiles.find((item) => item.id === id)
    if (!profile) throw new HttpError(404, 'connection_not_found', '模型连接不存在')
    return profile
  }

  private async change<T>(operation: () => Promise<T>, instanceId?: string): Promise<T> {
    if (this.closed) throw new HttpError(503, 'shutting_down', '服务正在停止')
    if (
      instanceId &&
      (this.changing.has(instanceId) ||
        this.signingOut.has(instanceId) ||
        this.isBusy(instanceId) ||
        this.isUpdating(instanceId))
    )
      throw new HttpError(409, 'connection_busy', '请先停止生成，再更改模型连接')
    if (instanceId) this.changing.add(instanceId)
    try {
      const run = () => {
        // Already-issued token rotations still persist before queued operations stop.
        if (this.closed) throw new HttpError(503, 'shutting_down', '服务正在停止')
        return operation()
      }
      return await (instanceId ? this.enqueueAccount(instanceId, run) : this.enqueue(run))
    } finally {
      if (instanceId) this.changing.delete(instanceId)
    }
  }

  createProfile(): Promise<string> {
    return this.change(async () => {
      const next = structuredClone(this.state)
      const id = randomUUID()
      next.profiles.push({ id, models: [] })
      await this.commit(next)
      return id
    })
  }

  removeProfile(instanceId: string, beforeRemove: () => Promise<void>): Promise<void> {
    return this.change(async () => {
      const profile = this.profile(instanceId)
      if (
        profile.tokens ||
        (this.attempt?.profileId === instanceId && this.attempt.view.status === 'pending')
      )
        throw new HttpError(409, 'authorization_active', '请先退出该账号或取消授权，再移除实例')
      await beforeRemove()
      await this.enqueue(async () => {
        const next = structuredClone(this.state)
        next.profiles = next.profiles.filter(({ id }) => id !== instanceId)
        await this.commit(next)
      })
    }, instanceId)
  }

  status(): { profiles: ChatGPTProfile[]; pendingLogin?: ChatGPTLogin } {
    const displayName = (profile: SavedProfile) => {
      const prefix = profile.id.slice(0, 8)
      const identifier = this.state.profiles.some(
        (other) => other.id !== profile.id && other.id.startsWith(prefix),
      )
        ? profile.id
        : prefix
      return `${profile.email ?? (profile.subject ? 'ChatGPT 账户' : '未完成的连接')} · ${identifier}`
    }
    return {
      ...(this.attempt?.view.status === 'pending'
        ? { pendingLogin: { ...this.attempt.view } }
        : {}),
      profiles: this.state.profiles.map((profile) => ({
        id: profile.id,
        name: displayName(profile),
        status:
          this.attempt?.profileId === profile.id && this.attempt.view.status === 'pending'
            ? 'authorizing'
            : this.changing.has(profile.id) ||
                this.signingOut.has(profile.id) ||
                this.isUpdating(profile.id)
              ? 'busy'
              : profile.reauth
                ? 'reauth_required'
                : profile.tokens
                  ? 'connected'
                  : 'signed_out',
        planUsage: Boolean(profile.tokens?.scopes.includes(PLAN_SCOPE)),
      })),
    }
  }

  model(instanceId: string, modelId: string): ChatGPTModel {
    const profile = this.profile(instanceId)
    if (
      this.closed ||
      this.changing.has(instanceId) ||
      (this.attempt?.profileId === instanceId && this.attempt.view.status === 'pending') ||
      this.signingOut.has(instanceId) ||
      !profile.tokens ||
      profile.reauth
    )
      throw new ModelError('auth_required')
    if (!profile.tokens.scopes.includes(PLAN_SCOPE)) throw new ModelError('permission_missing')
    return this.definition(instanceId, modelId)
  }

  definition(instanceId: string, modelId: string): ChatGPTModel {
    const profile = this.profile(instanceId)
    const model = profile.models.find((item) => item.id === modelId)
    if (!model || !this.supported.has(modelId))
      throw new HttpError(400, 'model_unavailable', '请选择当前连接可用的模型')
    return { ...model }
  }

  async beginLogin(profileId: string, timeoutMs = 900_000): Promise<ChatGPTLogin> {
    if (this.startingLogin || this.attempt?.view.status === 'pending')
      throw new HttpError(409, 'login_pending', '已有登录正在进行')
    this.startingLogin = true
    try {
      return await this.change(async () => {
        const profile = this.profile(profileId)
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
              void this.enqueueAccount(profileId, () => this.complete(attempt, url.searchParams))
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
        if (this.closed) {
          await new Promise<void>((done) => {
            server.close(() => done())
            server.closeAllConnections()
          })
          throw new HttpError(503, 'shutting_down', '服务正在停止')
        }
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('无法启动 OAuth 回调')
        const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
        const params = new URLSearchParams({
          client_id: profile.clientId ?? 'dynamic_agent_client',
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
        if (!profile.clientId) params.set('agent_name_hint', 'Pi Chat')
        if (profile.tokens && !profile.tokens.scopes.includes(PLAN_SCOPE))
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
            if (attempt.view.status === 'pending') {
              attempt.view.status = 'expired'
              this.release(attempt)
            }
          }, timeoutMs),
        }
        attempt.timer.unref()
        this.attempt = attempt
        return { ...view }
      }, profileId)
    } finally {
      this.startingLogin = false
    }
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
    const existing = this.profile(attempt.profileId)
    const clientId = params.get('client_id') ?? existing.clientId
    if (
      !code ||
      !clientId ||
      clientId === 'dynamic_agent_client' ||
      !/^[\w-]{1,200}$/.test(clientId) ||
      (existing.clientId && clientId !== existing.clientId)
    )
      throw new OAuthError('invalid_callback')
    if (!existing.clientId) {
      await this.enqueue(async () => {
        if (attempt.view.status !== 'pending' || this.closed) return
        const next = structuredClone(this.state)
        next.profiles.find((profile) => profile.id === existing.id)!.clientId = clientId
        // Keep the issued client ID even when code exchange or identity validation fails.
        await this.commit(next)
      })
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
    let completed = false
    try {
      if (attempt.view.status !== 'pending' || this.closed) return
      if (!tokens.idToken) throw new OAuthError('invalid_identity')
      const identity = await this.oauth.identity(tokens.idToken, clientId, attempt.nonce)
      if (existing.subject && identity.subject !== existing.subject)
        throw new OAuthError('identity_changed')
      const models = tokens.scopes.includes(PLAN_SCOPE)
        ? await this.catalog(tokens.accessToken).catch(() => [])
        : []
      if (attempt.view.status !== 'pending' || this.closed) return
      await this.enqueue(async () => {
        if (attempt.view.status !== 'pending' || this.closed) return
        const before = this.state
        const next = structuredClone(before)
        const profile = next.profiles.find((item) => item.id === attempt.profileId)!
        Object.assign(profile, identity, { tokens, reauth: false, models })
        await this.storage.save(next)
        if (attempt.view.status !== 'pending' || this.closed) {
          this.unpersisted = true
          await this.commit(before)
          return
        }
        this.state = next
        this.unpersisted = false
        attempt.view = { ...attempt.view, status: 'completed', instanceId: profile.id }
        completed = true
      })
    } finally {
      if (!completed && tokens.refreshToken)
        await this.oauth.revoke(clientId, tokens.refreshToken).catch(() => {})
    }
  }

  private async catalog(token: string): Promise<ChatGPTModel[]> {
    return (await this.oauth.models(token)).filter((model) => this.supported.has(model.id))
  }

  async models(instanceId: string, refresh = false): Promise<ChatGPTModel[]> {
    const profile = this.profile(instanceId)
    if (!profile.tokens?.scopes.includes(PLAN_SCOPE) || profile.reauth) return []
    if (!refresh) return [...profile.models]
    return this.change(async () => {
      const token = await this.resolveToken(profile.id)
      const models = await this.catalog(token)
      await this.enqueue(async () => {
        const next = structuredClone(this.state)
        next.profiles.find((item) => item.id === profile.id)!.models = models
        await this.commit(next)
      })
      return models
    }, instanceId)
  }

  token(instanceId: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (this.closed || this.changing.has(instanceId) || this.signingOut.has(instanceId))
      return Promise.reject(new ModelError('auth_required'))
    // Cancellation stops only the caller's wait; an issued replacement must still be saved.
    return waitFor(
      this.enqueueAccount(instanceId, () => {
        if (this.closed) throw new ModelError('auth_required')
        signal.throwIfAborted()
        return this.resolveToken(instanceId)
      }),
      signal,
    )
  }

  private async resolveToken(instanceId: string): Promise<string> {
    // A token may have rotated before a disk error. Retry its save, never reuse the old refresh token.
    if (this.unpersisted)
      await this.enqueue(async () => {
        if (this.unpersisted) await this.commit(this.state)
      })
    if (this.signingOut.has(instanceId)) throw new ModelError('auth_required')
    const profile = this.profile(instanceId)
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
          client_id: profile.clientId!,
          refresh_token: tokens.refreshToken,
        }),
      )
      await this.enqueue(async () => {
        const next = structuredClone(this.state)
        next.profiles.find((item) => item.id === profile.id)!.tokens = replacement
        this.state = next
        this.unpersisted = true
        await this.commit(next)
      })
      if (!replacement.scopes.includes(PLAN_SCOPE)) throw new ModelError('permission_missing')
      return replacement.accessToken
    } catch (error) {
      if (error instanceof OAuthError && terminalRefreshErrors.has(error.code)) {
        await this.enqueue(async () => {
          const next = structuredClone(this.state)
          const saved = next.profiles.find((item) => item.id === profile.id)!
          delete saved.tokens
          saved.reauth = true
          await this.commit(next)
        })
        throw new ModelError('auth_required')
      }
      throw error instanceof ModelError
        ? error
        : new ModelError('provider_failed', { cause: error })
    }
  }

  async failed(instanceId: string, code: ModelErrorCode): Promise<void> {
    if (this.closed || (code !== 'auth_required' && code !== 'permission_missing')) return
    await this.enqueueAccount(instanceId, () =>
      this.enqueue(async () => {
        const profile = this.state.profiles.find((item) => item.id === instanceId)
        if (!profile) return
        const next = structuredClone(this.state)
        const saved = next.profiles.find((item) => item.id === profile.id)!
        if (code === 'auth_required') {
          delete saved.tokens
          saved.reauth = true
        } else if (saved.tokens)
          saved.tokens.scopes = saved.tokens.scopes.filter((scope) => scope !== PLAN_SCOPE)
        await this.commit(next)
      }),
    )
  }

  async logout(instanceId: string, stop: () => Promise<void>): Promise<{ revoked: boolean }> {
    if (
      this.closed ||
      this.changing.has(instanceId) ||
      this.signingOut.has(instanceId) ||
      this.isUpdating(instanceId)
    )
      throw new HttpError(409, 'connection_busy', '模型连接正在更新')
    this.profile(instanceId)
    this.signingOut.add(instanceId)
    if (this.attempt?.profileId === instanceId && this.attempt.view.status === 'pending')
      this.cancelLogin(this.attempt.view.id)
    try {
      await stop()
      return await this.enqueueAccount(instanceId, async () => {
        const profile = this.profile(instanceId)
        let revoked = true
        if (profile.tokens?.refreshToken && profile.clientId) {
          try {
            await this.oauth.revoke(profile.clientId, profile.tokens.refreshToken)
          } catch {
            revoked = false
          }
        }
        await this.enqueue(async () => {
          const next = structuredClone(this.state)
          const saved = next.profiles.find((item) => item.id === profile.id)!
          delete saved.tokens
          delete saved.reauth
          await this.commit(next)
        })
        return { revoked }
      })
    } finally {
      this.signingOut.delete(instanceId)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.attempt?.view.status === 'pending') this.cancelLogin(this.attempt.view.id)
    await Promise.all(this.accounts.values())
    await this.tail
    if (this.unpersisted) await this.enqueue(() => this.commit(this.state))
  }
}
