import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { startServer } from '../../src/server.ts'
import { acquireDataDirectory } from '../../src/ownership.ts'
import {
  TOKEN,
  client,
  create,
  engine,
  events,
  fixture,
  settled,
  start,
} from '../helpers/server.mjs'

const MODULE_URL = new URL('../../src/server.ts', import.meta.url).href

function recoverServer(signal, start) {
  signal.throwIfAborted()
  const starting = start()
  return {
    ready: starting.then((server) => {
      signal.throwIfAborted()
      return server
    }),
    async close() {
      // Cancellation rejects ready, but cleanup still owns the startup's server.
      const server = await starting.catch(() => undefined)
      await server?.close()
    },
  }
}

test('idempotent retries survive model configuration loss after a service restart', async (t) => {
  const service = await fixture(t)
  const conversation = await create(service.request)
  const original = await start(service.request, conversation.id)
  await settled(service.request, conversation.id)
  await service.close()
  const unavailable = engine()
  unavailable.meta = () =>
    Promise.resolve({
      engine: 'pi',
      model: { provider: 'unconfigured', id: 'unconfigured' },
      configured: false,
      capabilities: { tools: false },
    })
  const restarted = await startServer({
    token: TOKEN,
    dataDir: service.dataDir,
    engine: unavailable,
  })
  const request = client(restarted.url)
  try {
    const retry = await start(request, conversation.id)
    assert.equal(retry.id, original.id)
    assert.equal(retry.status, 'completed')
    const conflict = await request(`/conversations/${conversation.id}/runs`, {
      method: 'POST',
      body: { requestId: 'request-0001', message: 'different' },
    })
    assert.equal(conflict.status, 409)
    assert.equal((await conflict.json()).error.code, 'idempotency_conflict')
    const fresh = await request(`/conversations/${conversation.id}/runs`, {
      method: 'POST',
      body: { requestId: 'request-fresh', message: 'new request' },
    })
    assert.equal(fresh.status, 503)
    const snapshot = await (await request(`/conversations/${conversation.id}`)).json()
    assert.equal(snapshot.messages.length, 2)
    assert.equal(unavailable.calls, 0)
  } finally {
    await restarted.close()
  }
})

test('graceful service shutdown interrupts work and reopening never replays it', async (t) => {
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  t.after(() => release.resolve())
  const slow = engine()
  slow.run = async () => {
    started.resolve()
    await release.promise
    return { text: 'after shutdown' }
  }
  const service = await fixture(t, { engine: slow })
  const conversation = await create(service.request)
  const run = await start(service.request, conversation.id)
  await started.promise
  const controller = new AbortController()
  t.after(() => controller.abort())
  const stream = await service.request(`/runs/${run.id}/events`, { signal: controller.signal })
  assert.equal(stream.status, 200)
  const streamFinished = Array.fromAsync(events(stream))
  // Observe any early stream failure while the shutdown assertions are running.
  void streamFinished.catch(() => {})
  const closing = service.close()
  try {
    const unavailable = await service.request('/meta')
    assert.equal(unavailable.status, 503)
    assert.equal((await unavailable.json()).error.code, 'shutting_down')
    const preflight = await fetch(`${service.url}/api/v1/meta`, { method: 'OPTIONS' })
    assert.equal(preflight.status, 204)
  } finally {
    release.resolve()
  }
  await closing
  const received = await Promise.race([
    streamFinished,
    delay(5000, undefined, { signal: controller.signal }).then(() => {
      throw new Error('SSE did not close during shutdown')
    }),
  ])
  controller.abort()
  assert.equal(received[0].type, 'snapshot')
  assert.equal(received.at(-1).type, 'run.updated')
  assert.equal(received.at(-1).run.status, 'interrupted')
  const nextEngine = engine()
  const next = await startServer({ token: TOKEN, dataDir: service.dataDir, engine: nextEngine })
  try {
    const snapshot = await (await client(next.url)(`/conversations/${conversation.id}`)).json()
    assert.equal(snapshot.run.status, 'interrupted')
    assert.equal(snapshot.messages[1].status, 'interrupted')
    assert.equal(nextEngine.calls, 0)
  } finally {
    await next.close()
  }
})

test(
  'a data directory has one owner and a rejected second service cannot interrupt active work',
  { timeout: 25_000 },
  async (t) => {
    let release
    const gate = new Promise((done) => {
      release = done
    })
    const primary = engine()
    primary.run = async (input) => {
      input.onDelta('before contention ')
      await gate
      input.signal.throwIfAborted()
      input.onDelta('after contention')
      return { text: 'before contention after contention' }
    }
    const service = await fixture(t, { engine: primary })
    const conversation = await create(service.request)
    const run = await start(service.request, conversation.id)
    const response = await service.request(`/runs/${run.id}/events`, {
      signal: AbortSignal.timeout(20_000),
    })
    const stream = events(response)
    const first = await stream.next()
    assert.equal(first.value.type, 'snapshot')
    assert.equal(first.value.snapshot.run.status, 'running')

    const touched = { meta: 0, run: 0, close: 0 }
    const secondary = {
      meta() {
        touched.meta++
        return engine().meta()
      },
      run() {
        touched.run++
        return Promise.resolve({ text: 'unexpected secondary execution' })
      },
      close() {
        touched.close++
        return Promise.resolve()
      },
    }
    let unexpectedService
    try {
      await assert.rejects(async () => {
        unexpectedService = await startServer({
          token: TOKEN,
          dataDir: service.dataDir,
          engine: secondary,
        })
      })
      assert.deepEqual(touched, { meta: 0, run: 0, close: 0 })
      const stillRunning = await (await service.request(`/conversations/${conversation.id}`)).json()
      assert.equal(stillRunning.run.id, run.id)
      assert.equal(stillRunning.run.status, 'running')
      assert.equal(stillRunning.messages[1].status, 'streaming')
      assert.equal(stillRunning.messages[1].content, 'before contention ')
      release()
      const received = [first.value]
      for await (const event of stream) received.push(event)
      assert.equal(received.at(-1).type, 'run.updated')
      assert.equal(received.at(-1).run.status, 'completed')
      const completed = await (await service.request(`/conversations/${conversation.id}`)).json()
      assert.equal(completed.run.status, 'completed')
      assert.equal(completed.messages[1].content, 'before contention after contention')
      assert.deepEqual(touched, { meta: 0, run: 0, close: 0 })
    } finally {
      release()
      await stream.return()
      await unexpectedService?.close()
    }
  },
)

test('a listen failure releases data directory ownership for an immediate retry', async (t) => {
  const occupying = await fixture(t)
  const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-listen-failure-'))
  let recovered
  t.after(async () => {
    await recovered?.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  await assert.rejects(
    startServer({
      token: TOKEN,
      dataDir,
      port: Number(new URL(occupying.url).port),
      engine: engine(),
    }),
    { code: 'EADDRINUSE' },
  )
  recovered = await startServer({ token: TOKEN, dataDir, port: 0, engine: engine() })
  assert.equal((await client(recovered.url)('/meta')).status, 200)
  assert.deepEqual(await (await client(recovered.url)('/conversations')).json(), [])
})

test(
  'a listen failure retains ownership until a slow engine has stopped',
  { timeout: 15_000 },
  async (t) => {
    const occupying = await fixture(t)
    const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-listen-drain-'))
    const finishClose = Promise.withResolvers()
    let closingStarted = false
    const slow = engine()
    slow.close = () => {
      closingStarted = true
      return finishClose.promise
    }
    let recovered
    t.after(async () => {
      finishClose.resolve()
      await recovered?.close()
      if (!recovered) {
        const release = await acquireDataDirectory(dataDir)
        await release()
      }
      assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()))
      assert.ok(basename(dataDir).startsWith('learn-electron-listen-drain-'))
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
    })

    await assert.rejects(
      startServer({
        token: TOKEN,
        dataDir,
        port: Number(new URL(occupying.url).port),
        engine: slow,
      }),
      { code: 'EADDRINUSE' },
    )
    assert.equal(closingStarted, true)
    await access(join(dataDir, '.service.lock'))
    finishClose.resolve()
    recovered = await startServer({ token: TOKEN, dataDir, engine: engine() })
    assert.equal((await client(recovered.url)('/meta')).status, 200)
  },
)

test('conversation deletion cleans native context before metadata and excludes new work', async (t) => {
  let finishDelete
  let deletionStarted
  const started = new Promise((done) => {
    deletionStarted = done
  })
  const finishing = new Promise((done) => {
    finishDelete = done
  })
  const fake = engine()
  fake.deleteConversation = async () => {
    deletionStarted()
    await finishing
  }
  const { request } = await fixture(t, { engine: fake })
  const conversation = await create(request)
  const deleting = request(`/conversations/${conversation.id}`, { method: 'DELETE' })
  await started
  const concurrent = await request(`/conversations/${conversation.id}/runs`, {
    method: 'POST',
    body: { message: 'too late', requestId: 'request-during-delete' },
  })
  assert.equal(concurrent.status, 409)
  finishDelete()
  assert.equal((await deleting).status, 204)
  assert.equal((await request(`/conversations/${conversation.id}`)).status, 404)
  assert.equal(fake.calls, 0)
})

test('shutdown saves other pending results when one finalization still fails', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-shutdown-finalization-'))
  const databasePath = join(dataDir, 'app.sqlite')
  const pending = []
  const fake = engine()
  fake.run = (input) =>
    new Promise((finish) => {
      pending.push({ input, finish })
    })
  let service
  let recovered
  let control
  t.after(async () => {
    if (control) {
      control.exec('DROP TRIGGER IF EXISTS reject_all; DROP TRIGGER IF EXISTS reject_first')
      control.close()
    }
    await service?.close().catch(() => {})
    await recovered?.close()
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()))
    assert.ok(basename(dataDir).startsWith('learn-electron-shutdown-finalization-'))
    await rm(dataDir, { recursive: true, force: true })
  })

  service = await startServer({ token: TOKEN, dataDir, engine: fake })
  const request = client(service.url)
  const first = await create(request)
  const second = await create(request)
  await start(request, first.id, 'shutdown-first')
  const secondRun = await start(request, second.id, 'shutdown-second')
  assert.deepEqual(
    pending.map(({ input }) => input.conversationId),
    [first.id, second.id],
  )

  control = new DatabaseSync(databasePath)
  control.exec(`CREATE TRIGGER reject_all BEFORE UPDATE OF sequence ON conversations
    BEGIN SELECT RAISE(ABORT, 'injected finalization failure'); END;`)
  pending[0].finish({ text: 'first completed answer' })
  pending[1].finish({ text: 'second completed answer' })
  await setImmediate()

  control.exec('DROP TRIGGER reject_all')
  control.exec(`CREATE TRIGGER reject_first BEFORE UPDATE OF sequence ON conversations
    WHEN OLD.id = '${first.id}' BEGIN SELECT RAISE(ABORT, 'first remains unavailable'); END;`)
  await assert.rejects(service.close(), { code: 'storage_unavailable' })
  control.exec('DROP TRIGGER reject_first')
  control.close()
  control = undefined

  const nextEngine = engine()
  recovered = await startServer({ token: TOKEN, dataDir, engine: nextEngine })
  const nextRequest = client(recovered.url)
  const firstSnapshot = await (await nextRequest(`/conversations/${first.id}`)).json()
  const snapshot = await (await nextRequest(`/conversations/${second.id}`)).json()
  assert.equal(firstSnapshot.run.status, 'interrupted')
  assert.equal(snapshot.run.id, secondRun.id)
  assert.equal(snapshot.run.status, 'completed')
  assert.equal(snapshot.messages[1].status, 'complete')
  assert.equal(snapshot.messages[1].content, 'second completed answer')
  assert.equal(pending.length, 2)
  assert.equal(nextEngine.calls, 0)
})

test(
  'crash recovery timeout waits for startup before closing the server and deleting its directory',
  { timeout: 10_000 },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-recovery-cancel-'))
    const startup = Promise.withResolvers()
    const timeout = new AbortController()
    const reason = new DOMException('Recovery startup timed out', 'TimeoutError')
    let closed = false
    let removing = false
    const server = {
      async close() {
        await access(dataDir)
        closed = true
      },
    }
    const recovery = recoverServer(timeout.signal, () => startup.promise)
    timeout.abort(reason)
    const cancelled = assert.rejects(recovery.ready, (error) => error === reason)
    const cleanup = (async () => {
      await recovery.close()
      removing = true
      assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()))
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
    })()
    t.after(async () => {
      startup.resolve(server)
      await Promise.all([cancelled, cleanup])
    })

    assert.throws(
      () => recoverServer(timeout.signal, () => assert.fail('Cancelled recovery must not start')),
      (error) => error === reason,
    )
    await setImmediate()
    assert.equal(removing, false, 'Directory cleanup must wait for the pending startup')
    assert.equal(closed, false)
    await access(dataDir)
    startup.resolve(server)
    await Promise.all([cancelled, cleanup])
    assert.equal(closed, true)
    await assert.rejects(access(dataDir), { code: 'ENOENT' })
  },
)

test(
  'crash recovery marks an unfinished run interrupted and never replays it',
  { timeout: 30_000 },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-crash-'))
    let recovery
    const script = `
    import { startServer } from ${JSON.stringify(MODULE_URL)};
    const engine = {
      meta: () => Promise.resolve({ engine: 'mock', model: { provider: 'test', id: 'crash' }, configured: true, capabilities: { tools: false } }),
      run: (input) => { input.onDelta('persisted before crash'); return new Promise(() => {}); },
      close: () => Promise.resolve()
    };
    const service = await startServer({ token: ${JSON.stringify(TOKEN)}, dataDir: ${JSON.stringify(dataDir)}, engine });
    process.send({ url: service.url });
  `
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      },
    )
    const closed = once(child, 'close')
    child.stdout.resume()
    child.stderr.resume()
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed
      await recovery?.close()
      assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()))
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
    })
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(10_000) })
    const request = client(ready.url)
    const conversation = await create(request)
    const run = await start(request, conversation.id)
    const before = await (await request(`/conversations/${conversation.id}`)).json()
    assert.equal(before.messages[1].content, 'persisted before crash')
    child.kill('SIGKILL')
    await closed
    const fake = engine()
    recovery = recoverServer(t.signal, () => startServer({ token: TOKEN, dataDir, engine: fake }))
    const recovered = await recovery.ready
    const nextClient = client(recovered.url)
    const snapshot = await (await nextClient(`/conversations/${conversation.id}`)).json()
    assert.equal(snapshot.run.id, run.id)
    assert.equal(snapshot.run.status, 'interrupted')
    assert.equal(snapshot.messages[1].status, 'interrupted')
    assert.equal(snapshot.messages[1].content, 'persisted before crash')
    assert.equal(fake.calls, 0)
  },
)
