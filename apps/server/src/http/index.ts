import { timingSafeEqual } from 'node:crypto'
import { METHODS, type IncomingMessage } from 'node:http'
import Fastify, { type FastifyInstance } from 'fastify'
import { API_PREFIX, type ApiError } from '@learn-electron/contracts'
import { ModelError, type AgentEngine } from '@learn-electron/agent-runtime'
import type { ChatService } from '../chat-service.ts'
import type { ChatGPTProvider } from '../chatgpt/provider.ts'
import { ChatError, HttpError, type ChatErrorCode } from '../errors.ts'
import type { ModelService } from '../model-service.ts'
import { registerChatRoutes } from './chat-routes.ts'
import { registerModelRoutes } from './model-routes.ts'

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

function authenticates(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const actual = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function createHttpServer(options: {
  token: string
  allowedOrigins: string[]
  isClosing: () => boolean
  chat: ChatService
  engine: AgentEngine
  models: ModelService | undefined
  chatgpt: ChatGPTProvider | undefined
}): FastifyInstance {
  const invalidUrls = new WeakMap<IncomingMessage, Error>()
  const encodedPaths = new WeakSet<IncomingMessage>()
  const app = Fastify({
    requestTimeout: 30_000,
    keepAliveTimeout: 5_000,
    maxRequestsPerSocket: 1000,
    forceCloseConnections: true,
    exposeHeadRoutes: false,
    return503OnClosing: false,
    routerOptions: { maxParamLength: 16 * 1024 },
    rewriteUrl(request) {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname.includes('%')) {
          try {
            decodeURI(url.pathname)
          } catch {
            // Defer the 404 until after Host, Origin, preflight and Bearer checks.
            invalidUrls.set(request, new HttpError(404, 'not_found', '接口不存在'))
            return '/'
          }
          encodedPaths.add(request)
        }
        return url.pathname + url.search
      } catch {
        invalidUrls.set(request, new Error('Invalid request URL'))
        return '/'
      }
    },
  })
  app.server.headersTimeout = 10_000

  // Keep Node's full method set for resource-specific error precedence. Disable
  // automatic parsing: several routes ignore bodies or reject requests before reading.
  for (const method of METHODS) {
    app.addHttpMethod(method, { hasBody: false, overrideExisting: true })
  }

  const origins = new Set(options.allowedOrigins)
  app.addHook('onRequest', async (request, reply) => {
    reply.raw.setHeader('Cache-Control', 'no-store')
    reply.raw.setHeader('X-Content-Type-Options', 'nosniff')
    const address = app.server.address()
    const expectedHost = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : ''
    if (request.headers.host !== expectedHost)
      throw new HttpError(403, 'invalid_host', '不允许的 Host')
    const origin = request.headers.origin
    if (origin && origin !== `http://${expectedHost}` && !origins.has(origin))
      throw new HttpError(403, 'invalid_origin', '不允许的 Origin')
    if (origin) {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin)
      reply.raw.setHeader('Vary', 'Origin')
    }
    if (request.method === 'OPTIONS') {
      return reply
        .code(204)
        .headers({
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '600',
        })
        .send()
    }
    if (!authenticates(request.headers.authorization, options.token))
      throw new HttpError(401, 'unauthorized', '需要有效的服务访问令牌')
    if (options.isClosing()) throw new HttpError(503, 'shutting_down', '服务正在停止')
    const invalidUrl = invalidUrls.get(request.raw)
    if (invalidUrl) throw invalidUrl
  })

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (reply.raw.headersSent) {
      reply.hijack()
      reply.raw.destroy()
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
    return reply.code(failure.status).send(body)
  })
  app.setNotFoundHandler(() => {
    throw new HttpError(404, 'not_found', '接口不存在')
  })
  app.register(
    (routes, _settings, done) => {
      // The v1 routes historically match the encoded pathname, without decoding it.
      routes.addHook('onRequest', (request, _reply, done) => {
        done(
          encodedPaths.has(request.raw) ? new HttpError(404, 'not_found', '接口不存在') : undefined,
        )
      })
      registerModelRoutes(routes, options.chat, options.engine, options.models, options.chatgpt)
      registerChatRoutes(routes, options.chat, options.models)
      done()
    },
    { prefix: API_PREFIX },
  )
  return app
}
