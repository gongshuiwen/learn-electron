import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createPiEngine, getOpenAIModels, type AgentEngine } from '@learn-electron/agent-runtime'
import type { ChatGPTOAuth } from '@learn-electron/chatgpt-auth'
import { ChatGPTProvider } from './chatgpt/provider.ts'
import { ModelService } from './model-service.ts'
import { ChatService } from './chat-service.ts'
import { createHttpServer } from './http/index.ts'
import { acquireDataDirectory } from './ownership.ts'
import { Store } from './store.ts'
import { waitWithin } from './wait-within.ts'

async function closeEngineAndRelease(
  engine: AgentEngine,
  releaseOwnership: () => Promise<void>,
): Promise<void> {
  const closing = engine.close()
  if (await waitWithin(closing, 3000)) await releaseOwnership()
  else {
    // A slow engine may still write its native context after the caller returns.
    void closing
      .then(() => releaseOwnership())
      .catch(() => console.error('模型引擎延迟关闭或数据目录锁释放失败'))
  }
}

export interface ServerOptions {
  port?: number
  host?: string
  token: string
  dataDir: string
  engine?: AgentEngine
  allowedOrigins?: string[]
  chatgptOAuth?: ChatGPTOAuth
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
    try {
      await (models ?? chatgpt)?.close()
    } finally {
      await releaseOwnership()
    }
    throw error
  }
  let store: Store
  try {
    store = new Store(join(directory, 'app.sqlite'))
  } catch (error) {
    try {
      await (models ?? chatgpt)?.close()
    } finally {
      await closeEngineAndRelease(engine, releaseOwnership)
    }
    throw error
  }
  const chat = new ChatService(store, engine, models)
  isChatBusy = (id) => chat.isBusy(id)
  let closing = false
  let http: ReturnType<typeof createHttpServer> | undefined
  try {
    const server = createHttpServer({
      token: options.token,
      allowedOrigins: options.allowedOrigins ?? [],
      isClosing: () => closing,
      chat,
      engine,
      models,
      chatgpt,
    })
    http = server
    const url = await server.listen({ port: options.port ?? 0, host: '127.0.0.1' })
    let closePromise: Promise<void> | undefined

    function close(): Promise<void> {
      closePromise ??= (async () => {
        closing = true
        try {
          // Stop callback admission immediately, then drain queued refresh persistence.
          const results = await Promise.allSettled([models?.close(), chat.close()])
          for (const result of results) if (result.status === 'rejected') throw result.reason
        } finally {
          try {
            await server.close()
          } finally {
            try {
              store.close()
            } finally {
              await closeEngineAndRelease(engine, releaseOwnership)
            }
          }
        }
      })()
      return closePromise
    }

    return { url, close }
  } catch (error) {
    await http?.close().catch(() => {})
    try {
      try {
        store.close()
      } finally {
        await (models ?? chatgpt)?.close()
      }
    } finally {
      await closeEngineAndRelease(engine, releaseOwnership)
    }
    throw error
  }
}
