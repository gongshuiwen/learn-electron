import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'

export interface Backend {
  url: string
  token: string
  close: () => Promise<void>
}

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
  const child = spawn(node, [entry], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  })
  child.stdout?.on('data', (chunk: Buffer) => log.info('[server]', chunk.toString().trim()))
  child.stderr?.on('data', (chunk: Buffer) => log.warn('[server]', chunk.toString().trim()))
  let closing = false
  let closePromise: Promise<void> | undefined
  child.on('error', (error) => log.error('Local server process error:', error))
  child.on('exit', (code, signal) => {
    if (!closing) log.error('Local server exited:', code, signal)
  })

  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Local server startup timed out')), 15_000)
      const onError = (error: Error): void => finish(error)
      const onExit = (): void => finish(new Error('Local server exited during startup'))
      const onMessage = (value: unknown): void => {
        if (typeof value !== 'object' || value === null || !('type' in value)) return
        if (value.type === 'ready' && 'url' in value && typeof value.url === 'string') {
          const address = new URL(value.url)
          if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1') {
            finish(new Error('Invalid local server address'))
          } else finish(undefined, address.origin)
        } else if (value.type === 'error') {
          finish(new Error('Local server could not start; see the application log'))
        }
      }
      function finish(error?: Error, address?: string): void {
        clearTimeout(timeout)
        child.off('error', onError)
        child.off('exit', onExit)
        child.off('message', onMessage)
        if (error) reject(error)
        else if (address) resolve(address)
      }
      child.once('error', onError)
      child.once('exit', onExit)
      child.on('message', onMessage)
      child.send({ type: 'start', token, dataDir: join(app.getPath('userData'), 'agent'), port: 0 })
    })
    log.info('Local server ready:', child.pid)
    return {
      url,
      token,
      close() {
        closing = true
        closePromise ??= stopChild(child)
        return closePromise
      },
    }
  } catch (error) {
    closing = true
    child.kill('SIGKILL')
    throw error
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 8_000)
    timer.unref()
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    if (child.connected) child.send({ type: 'shutdown' }, () => undefined)
    else child.kill()
  })
}
