import { createMockEngine } from '@learn-electron/agent-runtime'
import { startServer, type ServerOptions } from './server.ts'

type RunningServer = Awaited<ReturnType<typeof startServer>>
type StartupOptions = Pick<ServerOptions, 'token' | 'dataDir' | 'port'>

export function createServerProcess(reportError?: (message: string) => Promise<void>) {
  let starting: Promise<RunningServer> | undefined
  let stopping: Promise<void> | undefined
  let exiting: Promise<void> | undefined
  let failure: string | undefined

  function fail(error: unknown): void {
    process.exitCode = 1
    if (failure !== undefined) return
    failure = error instanceof Error ? error.message : '服务启动或关闭失败'
    console.error(failure)
  }

  async function start(options: StartupOptions): Promise<RunningServer | undefined> {
    if (starting || stopping) throw new Error('服务已启动或正在停止')
    starting = Promise.resolve()
      .then(() => {
        const engine = process.env.APP_ENGINE
        if (engine && engine !== 'pi' && engine !== 'mock')
          throw new Error('APP_ENGINE 仅支持 pi 或 mock')
        return startServer({
          ...options,
          allowedOrigins: (process.env.APP_ALLOWED_ORIGINS ?? '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
          ...(engine === 'mock' ? { engine: createMockEngine() } : {}),
        })
      })
      .catch((error: unknown) => {
        fail(error)
        throw error
      })
    const server = await starting
    return stopping ? undefined : server
  }

  function stop(): Promise<void> {
    stopping ??= (async () => {
      const server = await starting?.catch(() => undefined)
      await server?.close()
    })()
    return stopping
  }

  function shutdown(error?: unknown): Promise<void> {
    if (error !== undefined) fail(error)
    exiting ??= (async () => {
      try {
        await stop()
      } catch (error) {
        fail(error)
      }
      if (failure !== undefined) {
        // A disconnected supervisor cannot receive the error; cleanup still ends.
        await reportError?.(failure).catch(() => undefined)
      }
      process.exit()
    })()
    return exiting
  }

  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
  return { start, shutdown }
}
