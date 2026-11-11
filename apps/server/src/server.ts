import { timingSafeEqual } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve, join } from 'node:path'
import {
  API_PREFIX,
  parseStartRun,
  parseTitle,
  type ApiError,
  type RunEvent,
} from '@learn-electron/contracts'
import {
  createPiEngine,
  getOpenAIModels,
  ModelError,
  type AgentEngine,
} from '@learn-electron/agent-runtime'
import { ChatGPTProvider } from './chatgpt/provider.ts'
import { ModelService } from './model-service.ts'
import {
  parseSaveProvider,
  parseModelRef,
  parseProviderTest,
  parseCreateConversation,
  modelAdapters,
} from '@learn-electron/contracts/models'
import { isObject } from '@learn-electron/model-connections'
import type { ChatGPTOAuth } from '@learn-electron/chatgpt-auth'
import { ChatService } from './chat-service.ts'
import { ChatError, HttpError, type ChatErrorCode } from './errors.ts'
import { acquireDataDirectory } from './ownership.ts'
import { Store } from './store.ts'
import { waitWithin } from './wait-within.ts'

export interface ServerOptions {
  port?: number
  host?: string
  token: string
  dataDir: string
  engine?: AgentEngine
  allowedOrigins?: string[]
  chatgptOAuth?: ChatGPTOAuth
}

const MAX_BODY_BYTES = 160 * 1024
const MAX_STREAM_BUFFER = 1024 * 1024
const CHAT_ERROR_STATUS: Record<ChatErrorCode, number> = {
  conversation_not_found: 404,
  run_not_found: 404,
  conversation_busy: 409,
  idempotency_conflict: 409,
  engine_not_configured: 503,
  storage_unavailable: 503,
  shutting_down: 503,
  connection_changed: 409,
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    return Promise.reject(
      new HttpError(415, 'unsupported_media_type', '请求须使用 application/json'),
    )
  }
  return new Promise((resolveBody, rejectBody) => {
    let bytes = 0
    const chunks: Buffer[] = []
    let rejected = false
    request.on('data', (chunk: Buffer) => {
      if (rejected) return
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        rejected = true
        chunks.length = 0
        rejectBody(new HttpError(413, 'body_too_large', '请求内容过大'))
      } else chunks.push(chunk)
    })
    request.once('end', () => {
      if (rejected) return
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
      } catch {
        rejectBody(new HttpError(400, 'invalid_json', 'JSON 格式无效'))
      }
    })
    request.once('error', rejectBody)
    request.once('aborted', () => rejectBody(new HttpError(400, 'request_aborted', '请求已中断')))
  })
}

function parse<T>(parser: (value: unknown) => T, value: unknown): T {
  try {
    return parser(value)
  } catch (error) {
    throw new HttpError(400, 'invalid_request', error instanceof Error ? error.message : '请求无效')
  }
}

function authenticates(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const actual = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function startServer(
  options: ServerOptions,
): Promise<{ url: string; close: () => Promise<void> }> {
  if (!options.token.trim()) throw new Error('APP_API_TOKEN 必填，请提供随机生成的服务访问令牌')
  if (options.host && options.host !== '127.0.0.1') throw new Error('本服务仅支持绑定 127.0.0.1')
  const directory = resolve(options.dataDir)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const releaseOwnership = await acquireDataDirectory(directory)
  let chatgpt: ChatGPTProvider | undefined
  let models: ModelService | undefined
  let isChatBusy = (_instanceId?: string) => false
  let engine: AgentEngine
  try {
    if (!options.engine) {
      chatgpt = await ChatGPTProvider.create({
        dataDir: directory,
        models: await getOpenAIModels(),
        isBusy: (id) => isChatBusy(id),
        isUpdating: (id) => models?.isChanging(id) ?? false,
        oauth: options.chatgptOAuth,
      })
      models = await ModelService.create(directory, chatgpt, (id) => isChatBusy(id))
    }
    engine =
      options.engine ??
      (await createPiEngine({
        dataDir: join(directory, 'pi'),
        ...(models ? { credentials: models } : {}),
      }))
  } catch (error) {
    await (models ?? chatgpt)?.close()
    await releaseOwnership()
    throw error
  }
  let store: Store
  try {
    store = new Store(join(directory, 'app.sqlite'))
  } catch (error) {
    try {
      await waitWithin(engine.close(), 3000)
      await (models ?? chatgpt)?.close()
    } finally {
      await releaseOwnership()
    }
    throw error
  }
  const chat = new ChatService(store, engine, models)
  isChatBusy = (id) => chat.isBusy(id)
  const origins = new Set(options.allowedOrigins ?? [])
  let expectedHost = ''
  let url = ''
  let closing = false
  let closePromise: Promise<void> | undefined

  function sendEvent(response: ServerResponse, event: RunEvent): void {
    if (response.destroyed || response.writableEnded) return
    if (response.writableLength > MAX_STREAM_BUFFER) {
      response.destroy()
      return
    }
    response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    if (request.headers.host !== expectedHost)
      throw new HttpError(403, 'invalid_host', '不允许的 Host')
    const origin = request.headers.origin
    if (origin && !origins.has(origin))
      throw new HttpError(403, 'invalid_origin', '不允许的 Origin')
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Vary', 'Origin')
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
      })
      response.end()
      return
    }
    if (!authenticates(request.headers.authorization, options.token)) {
      throw new HttpError(401, 'unauthorized', '需要有效的服务访问令牌')
    }
    if (closing) throw new HttpError(503, 'shutting_down', '服务正在停止')
    const requestUrl = new URL(request.url ?? '/', url)
    const pathname = requestUrl.pathname
    const method = request.method
    if (pathname === `${API_PREFIX}/model-adapters` && method === 'GET') {
      json(response, 200, modelAdapters)
      return
    }
    const providerRoute =
      /^\/api\/v1\/model-providers\/([\w-]+)(?:\/(models|models\/refresh|test|auth\/attempts|auth\/logout))?$/.exec(
        pathname,
      )
    if (pathname === `${API_PREFIX}/model-providers` || providerRoute) {
      if (!models) {
        if (pathname === `${API_PREFIX}/model-providers` && method === 'GET') {
          json(response, 200, {
            defaultSelection: null,
            instances: [],
            chatgpt: { enabled: false },
          })
          return
        }
        throw new HttpError(409, 'engine_disabled', '演示模式不支持模型供应商配置')
      }
      const id = providerRoute?.[1]
      const action = providerRoute?.[2]
      if (!id && method === 'GET') json(response, 200, models.status())
      else if (!id && method === 'POST') {
        const body = await readJson(request)
        json(
          response,
          201,
          isObject(body) && body.kind === 'chatgpt'
            ? await models.createAccount()
            : await models.save(parse(parseSaveProvider, body)),
        )
      } else if (id && !action && method === 'PATCH')
        json(
          response,
          200,
          await models.save(parse(parseSaveProvider, await readJson(request)), id),
        )
      else if (id && !action && method === 'DELETE') json(response, 200, await models.remove(id))
      else if (id && action === 'models' && method === 'GET')
        json(response, 200, await models.models(id))
      else if (id && action === 'models/refresh' && method === 'POST')
        json(response, 200, await models.refreshModels(id))
      else if (id && action === 'test' && method === 'POST') {
        const { modelId } = parse(parseProviderTest, await readJson(request))
        if (!engine.testConnection)
          throw new HttpError(409, 'engine_disabled', '当前引擎不支持连接测试')
        await models.test(id, modelId, (target, signal) => engine.testConnection!(target, signal))
        response.writeHead(204)
        response.end()
      } else if (id && action?.startsWith('auth/')) {
        if (!chatgpt) throw new HttpError(409, 'engine_disabled', '当前引擎不支持授权')
        const instance = models.status().instances.find((item) => item.id === id)
        if (!instance) throw new HttpError(404, 'provider_not_found', '模型供应商实例不存在')
        if (instance.kind !== 'chatgpt')
          throw new HttpError(409, 'auth_unsupported', '该实例不支持网页登录')
        if (action === 'auth/attempts' && method === 'POST')
          json(response, 201, await chatgpt.beginLogin(id))
        else if (action === 'auth/logout' && method === 'POST')
          json(response, 200, await chatgpt.logout(id, () => chat.cancelAll(id)))
        else throw new HttpError(405, 'method_not_allowed', '不支持的请求方法')
      } else throw new HttpError(405, 'method_not_allowed', '不支持的请求方法')
      return
    }
    const attemptRoute = /^\/api\/v1\/model-auth-attempts\/([\w-]+)(\/cancel)?$/.exec(pathname)
    if (attemptRoute?.[1]) {
      if (!chatgpt) throw new HttpError(409, 'engine_disabled', '演示模式不支持登录')
      if (!attemptRoute[2] && method === 'GET') json(response, 200, chatgpt.login(attemptRoute[1]))
      else if (attemptRoute[2] && method === 'POST') {
        chatgpt.cancelLogin(attemptRoute[1])
        response.writeHead(204)
        response.end()
      } else throw new HttpError(405, 'method_not_allowed', '不支持的请求方法')
      return
    }
    if (pathname === `${API_PREFIX}/model` && method === 'PUT') {
      if (!models) throw new HttpError(409, 'engine_disabled', '当前引擎不支持模型选择')
      json(response, 200, await models.select(parse(parseModelRef, await readJson(request))))
      return
    }
    if (pathname === `${API_PREFIX}/meta` && method === 'GET') {
      json(response, 200, await chat.meta())
      return
    }
    if (pathname === `${API_PREFIX}/conversations`) {
      if (method === 'GET') json(response, 200, chat.listConversations())
      else if (method === 'POST') {
        const body = request.headers['content-type'] ? await readJson(request) : {}
        json(response, 201, chat.createConversation(parse(parseCreateConversation, body).selection))
      } else throw new HttpError(405, 'method_not_allowed', '不支持的请求方法')
      return
    }
    const conversationRoute = /^\/api\/v1\/conversations\/([\w-]+)(\/runs|\/model)?$/.exec(pathname)
    if (conversationRoute?.[1]) {
      const conversationId = conversationRoute[1]
      if (conversationRoute[2] === '/model') {
        if (method !== 'PUT') throw new HttpError(405, 'method_not_allowed', '不支持的请求方法')
        if (!models) throw new HttpError(409, 'engine_disabled', '当前引擎不支持模型选择')
        json(
          response,
          200,
          await chat.selectConversationModel(
            conversationId,
            parse(parseModelRef, await readJson(request)),
          ),
        )
      } else if (conversationRoute[2]) {
        if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', '不支持的请求方法')
        const body = parse(parseStartRun, await readJson(request))
        json(response, 202, await chat.startRun(conversationId, body))
      } else if (method === 'GET') json(response, 200, await chat.getConversation(conversationId))
      else if (method === 'PATCH')
        json(
          response,
          200,
          chat.renameConversation(conversationId, parse(parseTitle, await readJson(request))),
        )
      else if (method === 'DELETE') {
        await chat.deleteConversation(conversationId)
        response.writeHead(204)
        response.end()
      } else throw new HttpError(405, 'method_not_allowed', '不支持的请求方法')
      return
    }
    const runRoute = /^\/api\/v1\/runs\/([\w-]+)\/(events|cancel)$/.exec(pathname)
    if (runRoute?.[1]) {
      if (runRoute[2] === 'cancel' && method === 'POST') {
        json(response, 200, chat.cancelRun(runRoute[1]))
        return
      }
      if (runRoute[2] === 'events' && method === 'GET') {
        const subscription = await chat.subscribe(runRoute[1], {
          event: (event) => sendEvent(response, event),
          close: (error) => {
            if (error) response.destroy()
            else response.end()
          },
        })
        if (response.destroyed) {
          subscription.unsubscribe()
          return
        }
        response.once('close', subscription.unsubscribe)
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'X-Accel-Buffering': 'no',
          Connection: 'keep-alive',
        })
        response.flushHeaders()
        sendEvent(response, subscription.snapshot)
        if (!subscription.active) {
          response.end()
          return
        }
        const heartbeat = setInterval(() => {
          if (response.writableLength > MAX_STREAM_BUFFER) response.destroy()
          else response.write(': heartbeat\n\n')
        }, 15_000)
        heartbeat.unref()
        response.once('close', () => clearInterval(heartbeat))
        return
      }
      chat.getRun(runRoute[1])
      throw new HttpError(405, 'method_not_allowed', '不支持的请求方法')
    }
    throw new HttpError(404, 'not_found', '接口不存在')
  }

  const server = createServer(
    { requestTimeout: 30_000, headersTimeout: 10_000 },
    (request, response) => {
      void handle(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy()
          return
        }
        const failure =
          error instanceof HttpError
            ? error
            : error instanceof ChatError
              ? new HttpError(CHAT_ERROR_STATUS[error.code], error.code, error.message)
              : error instanceof ModelError
                ? new HttpError(503, error.code, error.message)
                : new HttpError(500, 'internal_error', '服务处理请求失败')
        const body: ApiError = { error: { code: failure.code, message: failure.message } }
        json(response, failure.status, body)
      })
    },
  )
  server.maxRequestsPerSocket = 1000
  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', rejectListening)
      const address = server.address()
      if (!address || typeof address === 'string') {
        rejectListening(new Error('无法读取服务地址'))
        return
      }
      expectedHost = `127.0.0.1:${address.port}`
      url = `http://${expectedHost}`
      origins.add(url)
      resolveListening()
    })
  }).catch(async (error: unknown) => {
    try {
      store.close()
      await waitWithin(engine.close(), 3000)
      await (models ?? chatgpt)?.close()
    } finally {
      await releaseOwnership()
    }
    throw error
  })

  function close(): Promise<void> {
    closePromise ??= (async () => {
      closing = true
      try {
        // Stop callback admission immediately, then drain queued refresh persistence.
        const results = await Promise.allSettled([models?.close(), chat.close()])
        for (const result of results) if (result.status === 'rejected') throw result.reason
      } finally {
        await new Promise<void>((done) => {
          server.close(() => done())
          server.closeAllConnections()
        })
        try {
          store.close()
        } finally {
          const engineClosing = engine.close()
          if (await waitWithin(engineClosing, 3000)) await releaseOwnership()
          else {
            // A stuck engine may still write its native context. Retain the
            // lease until it really stops (or the supervisor exits this process).
            void engineClosing.then(releaseOwnership).catch(() => {})
          }
        }
      }
    })()
    return closePromise
  }

  return { url, close }
}
