import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'

export interface Backend {
  readonly url: string | undefined
  readonly token: string
  close: () => Promise<void>
}

const RESTART_DELAYS = [500, 1500, 4000]
const HEALTHY_INTERVAL = 60_000

export async function startBackend(): Promise<Backend> {
  if (!app.isPackaged) {
    try {
      process.loadEnvFile(resolve('.env'))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  const node = app.isPackaged
    ? join(process.resourcesPath, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
    : process.env.APP_NODE_EXECUTABLE || process.env.npm_node_execpath || 'node'
  const entry = app.isPackaged
    ? join(process.resourcesPath, 'server/desktop-child.mjs')
    : join(import.meta.dirname, '../server/desktop-child.mjs')
  const token = randomBytes(32).toString('hex')
  let child: ChildProcess | undefined
  let url: string | undefined
  let closing = false
  let closePromise: Promise<void> | undefined
  let restarting: Promise<void> | undefined
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let restartAttempts = 0
  let readyAt = 0

  function scheduleRestart(): void {
    if (closing) return
    const delay = RESTART_DELAYS[restartAttempts]
    if (delay === undefined) {
      log.error('Local server restart limit reached; restart the application to retry')
      return
    }
    restartAttempts++
    log.warn('Restarting local server:', restartAttempts, `in ${delay}ms`)
    restartTimer = setTimeout(() => {
      restartTimer = undefined
      restarting = launch()
        .catch((error: unknown) => {
          if (!closing) log.error('Unable to restart local server:', error)
          scheduleRestart()
        })
        .finally(() => {
          restarting = undefined
        })
    }, delay)
  }

  async function launch(): Promise<void> {
    if (closing) return
    const processChild = spawn(node, [entry], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    })
    child = processChild
    log.info('Starting local server:', processChild.pid)
    processChild.stdout?.on('data', (chunk: Buffer) =>
      log.info('[server]', chunk.toString().trim()),
    )
    processChild.stderr?.on('data', (chunk: Buffer) =>
      log.warn('[server]', chunk.toString().trim()),
    )
    processChild.on('error', (error) => log.error('Local server process error:', error))
    processChild.once('exit', (code, signal) => {
      if (child !== processChild) return
      child = undefined
      const wasReady = url !== undefined
      url = undefined
      if (closing) return
      log.error('Local server exited:', code, signal)
      // Startup failures are retried by the caller, after the old child is reaped.
      if (wasReady) {
        if (Date.now() - readyAt >= HEALTHY_INTERVAL) restartAttempts = 0
        scheduleRestart()
      }
    })

    try {
      const address = await new Promise<string>((resolve, reject) => {
        let settled = false
        const timeout = setTimeout(
          () => finish(new Error('Local server startup timed out')),
          15_000,
        )
        const onError = (error: Error): void => finish(error)
        const onExit = (): void => finish(new Error('Local server exited during startup'))
        const onMessage = (value: unknown): void => {
          if (typeof value !== 'object' || value === null || !('type' in value)) return
          if (value.type === 'ready' && 'url' in value && typeof value.url === 'string') {
            try {
              const address = new URL(value.url)
              if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1') {
                finish(new Error('Invalid local server address'))
              } else finish(undefined, address.origin)
            } catch (error) {
              finish(error instanceof Error ? error : new Error('Invalid local server address'))
            }
          } else if (value.type === 'error') {
            finish(new Error('Local server could not start; see the application log'))
          }
        }
        function finish(error?: Error, address?: string): void {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          processChild.off('error', onError)
          processChild.off('exit', onExit)
          processChild.off('message', onMessage)
          if (error) reject(error)
          else if (address) resolve(address)
        }
        processChild.once('error', onError)
        processChild.once('exit', onExit)
        processChild.on('message', onMessage)
        processChild.send(
          { type: 'start', token, dataDir: join(app.getPath('userData'), 'agent'), port: 0 },
          (error) => {
            if (error) finish(error)
          },
        )
      })
      if (!closing && child === processChild) {
        url = address
        readyAt = Date.now()
        log.info('Local server ready:', processChild.pid)
      }
    } catch (error) {
      await stopChild(processChild, true)
      throw error
    }
  }

  try {
    await launch()
  } catch (error) {
    closing = true
    throw error
  }
  return {
    get url() {
      return url
    },
    token,
    close() {
      closing = true
      url = undefined
      clearTimeout(restartTimer)
      closePromise ??= (async () => {
        if (child) await stopChild(child)
        await restarting
      })()
      return closePromise
    },
  }
}

async function stopChild(child: ChildProcess, force = false): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    // Allow bounded OAuth refresh, discovery and revocation to finish before the fallback.
    const grace = 60_000
    const timer = setTimeout(() => child.kill('SIGKILL'), grace)
    timer.unref()
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    if (force) child.kill('SIGKILL')
    else if (child.connected)
      child.send({ type: 'shutdown' }, (error) => {
        if (error) child.kill('SIGKILL')
      })
    else child.kill()
  })
}
