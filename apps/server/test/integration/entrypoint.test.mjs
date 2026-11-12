import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { on, once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const { AbortSignal, fetch, URL } = globalThis
const LOADER = import.meta.resolve('tsx')
const TOKEN = 'entrypoint-test-secret-token'

async function launch(t, { desktop = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'learn-electron-entrypoint-'))
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('APP_')) delete environment[key]
  }
  await writeFile(
    join(directory, '.env'),
    `APP_API_TOKEN=${TOKEN}\nAPP_PORT=0\nAPP_DATA_DIR=data\nAPP_ENGINE=mock\nAPP_ALLOWED_ORIGINS=https://from-dotenv.invalid\n`,
  )
  if (desktop) environment.APP_ENGINE = 'mock'
  const child = spawn(
    process.execPath,
    [
      '--import',
      LOADER,
      fileURLToPath(new URL(`../../src/${desktop ? 'desktop-child' : 'cli'}.ts`, import.meta.url)),
    ],
    {
      cwd: directory,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    },
  )
  // Node 24 can omit ChildProcess 'close' after an explicit IPC disconnect.
  const closed = Promise.all([
    once(child, 'exit'),
    once(child, 'disconnect'),
    finished(child.stdout, { cleanup: true }),
    finished(child.stderr, { cleanup: true }),
  ]).then(([result]) => result)
  const messages = []
  child.on('message', (message) => messages.push(message))
  child.stderr.resume()
  if (desktop) child.stdout.resume()
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    child.stdout.resume()
    await closed
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('learn-electron-entrypoint-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
  })
  return { child, directory, closed, messages }
}

test(
  'standalone entry loads .env and listens even with inherited IPC',
  { timeout: 10_000 },
  async (t) => {
    const { child } = await launch(t)
    let output = ''
    let url
    for await (const [chunk] of on(child.stdout, 'data', { signal: AbortSignal.timeout(5000) })) {
      output += chunk.toString()
      url = /Agent service listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]
      if (url) break
    }
    assert.ok(url, output)
    const response = await fetch(`${url}/api/v1/conversations`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), [])
  },
)

for (const shutdown of ['message', 'disconnect']) {
  test(
    `desktop entry starts through IPC and closes on ${shutdown}`,
    { timeout: 10_000 },
    async (t) => {
      const { child, directory, closed } = await launch(t, { desktop: true })
      const ready = once(child, 'message', { signal: AbortSignal.timeout(5000) })
      child.send({ type: 'start', token: TOKEN, dataDir: join(directory, 'desktop-data') })
      const [message] = await ready
      assert.equal(message.type, 'ready')
      const response = await fetch(`${message.url}/api/v1/meta`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://from-dotenv.invalid' },
        signal: AbortSignal.timeout(5000),
      })
      assert.equal(response.status, 403, 'desktop entry must ignore the working directory .env')
      if (shutdown === 'message') child.send({ type: 'shutdown' })
      else child.disconnect()
      assert.deepEqual(await closed, [0, null])
    },
  )
}

test(
  'desktop startup failure reports an error and exits with status 1',
  { timeout: 10_000 },
  async (t) => {
    const { child, directory, closed, messages } = await launch(t, { desktop: true })
    child.send({ type: 'start', token: '', dataDir: join(directory, 'desktop-data') })
    assert.deepEqual(await closed, [1, null])
    assert.equal(messages.length, 1)
    assert.equal(messages[0].type, 'error')
    assert.match(messages[0].message, /APP_API_TOKEN/)
  },
)

test('shutdown during startup closes without reporting ready', { timeout: 10_000 }, async (t) => {
  const { child, directory, closed, messages } = await launch(t, { desktop: true })
  child.send({ type: 'start', token: TOKEN, dataDir: join(directory, 'desktop-data') })
  child.send({ type: 'shutdown' })
  assert.deepEqual(await closed, [0, null])
  assert.deepEqual(messages, [])
})
