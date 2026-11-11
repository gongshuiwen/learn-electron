import assert from 'node:assert/strict'
import { once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { request as httpRequest, ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { startServer } from '../src/server.ts'
import { ChatService } from '../src/chat-service.ts'

const { fetch, AbortSignal, TextDecoder, URL } = globalThis
const TOKEN = 'integration-test-secret-token'
const MODULE_URL = new URL('../src/server.ts', import.meta.url).href

function engine({ chunks = ['hello ', 'world'], interval = 25, fail = false } = {}) {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    meta() {
      return Promise.resolve({
        engine: 'mock',
        model: { provider: 'test', id: 'deterministic' },
        configured: true,
        capabilities: { tools: false },
      })
    },
    async run(input) {
      calls++
      for (const chunk of chunks) {
        await delay(interval, undefined, { signal: input.signal })
        input.onDelta(chunk)
      }
      if (fail) throw new Error('private-provider-secret')
      return { text: chunks.join('') }
    },
    close() {
      return Promise.resolve()
    },
  }
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-server-'))
  const fake = options.engine ?? engine()
  const service = await startServer({
    token: TOKEN,
    dataDir,
    engine: fake,
    allowedOrigins: ['http://localhost:5173'],
    ...options,
  })
  t.after(async () => {
    await service.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return { ...service, dataDir, engine: fake, request: client(service.url) }
}

function client(url) {
  return async (path, options = {}) => {
    const { body, headers, ...rest } = options
    return fetch(`${url}/api/v1${path}`, {
      ...rest,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      signal: options.signal ?? AbortSignal.timeout(5000),
    })
  }
}

async function create(request) {
  const response = await request('/conversations', { method: 'POST' })
  assert.equal(response.status, 201)
  return response.json()
}

async function start(request, id, requestId = 'request-0001', message = 'hello') {
  const response = await request(`/conversations/${id}/runs`, {
    method: 'POST',
    body: { message, requestId },
  })
  assert.equal(response.status, 202)
  return response.json()
}

async function* events(response) {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  let buffer = ''
  const decoder = new TextDecoder()
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true })
    let end
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = frame.split('\n').find((line) => line.startsWith('data: '))
      if (data) yield JSON.parse(data.slice(6))
    }
  }
}

async function settled(request, conversationId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = await (await request(`/conversations/${conversationId}`)).json()
    if (!['running', 'cancelling'].includes(snapshot.run?.status)) return snapshot
    await delay(10)
  }
  throw new Error('Run did not settle')
}

test('loopback API requires authentication and validates Host, Origin and CORS', async (t) => {
  const service = await fixture(t)
  const { url, request } = service
  assert.equal((await fetch(`${url}/api/v1/meta`)).status, 401)
  assert.equal((await request('/meta', { headers: { Authorization: 'Bearer wrong' } })).status, 401)
  const forgedHost = await new Promise((resolveResponse, rejectResponse) => {
    const raw = httpRequest(
      `${url}/api/v1/meta`,
      { headers: { Host: 'attacker.invalid', Authorization: `Bearer ${TOKEN}` } },
      (response) => {
        response.resume()
        resolveResponse(response.statusCode)
      },
    )
    raw.once('error', rejectResponse)
    raw.end()
  })
  assert.equal(forgedHost, 403)
  assert.equal(
    (await request('/meta', { headers: { Origin: 'https://attacker.invalid' } })).status,
    403,
  )
  assert.equal((await request('/meta', { headers: { Origin: 'null' } })).status, 403)
  const preflight = await fetch(`${url}/api/v1/conversations`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Headers': 'authorization' },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173')
  const meta = await (await request('/meta')).json()
  assert.equal(meta.apiVersion, 1)
  assert.equal(meta.engine, 'mock')
  assert.equal(meta.capabilities.tools, false)
  await assert.rejects(
    startServer({ token: '', dataDir: service.dataDir, engine: engine() }),
    /APP_API_TOKEN/,
  )
  await assert.rejects(
    startServer({ token: TOKEN, host: '0.0.0.0', dataDir: service.dataDir, engine: engine() }),
    /127.0.0.1/,
  )
})

test('conversation CRUD, validation and request body bounds use stable error DTOs', async (t) => {
  const { request } = await fixture(t)
  const conversation = await create(request)
  assert.equal((await (await request('/conversations')).json()).length, 1)
  const renamed = await request(`/conversations/${conversation.id}`, {
    method: 'PATCH',
    body: { title: 'Renamed' },
  })
  assert.equal((await renamed.json()).title, 'Renamed')
  assert.equal(
    (await request(`/conversations/${conversation.id}`, { method: 'PATCH', body: { title: '' } }))
      .status,
    400,
  )
  const invalid = await request(`/conversations/${conversation.id}/runs`, {
    method: 'POST',
    body: { message: '', requestId: 'bad' },
  })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.code, 'invalid_request')
  assert.equal(
    (await request(`/conversations/${conversation.id}/runs`, { method: 'POST', body: '{' })).status,
    400,
  )
  assert.equal(
    (
      await request(`/conversations/${conversation.id}/runs`, {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'text/plain' },
      })
    ).status,
    415,
  )
  assert.equal(
    (
      await request(`/conversations/${conversation.id}/runs`, {
        method: 'POST',
        body: { message: 'x'.repeat(170_000), requestId: 'request-body' },
      })
    ).status,
    413,
  )
  assert.equal(
    (await request(`/conversations/${conversation.id}`, { method: 'DELETE' })).status,
    204,
  )
  assert.equal((await request(`/conversations/${conversation.id}`)).status, 404)
})

test('real HTTP/SSE streams snapshot, ordered deltas, final message and terminal run', async (t) => {
  const { request } = await fixture(t)
  const conversation = await create(request)
  const run = await start(request, conversation.id)
  const received = []
  for await (const event of events(await request(`/runs/${run.id}/events`))) received.push(event)
  assert.equal(received[0].type, 'snapshot')
  assert.ok(received.some((event) => event.type === 'message.delta'))
  assert.equal(received.at(-1).type, 'run.updated')
  assert.equal(received.at(-1).run.status, 'completed')
  assert.equal(received.at(-2).type, 'message.completed')
  assert.equal(received.at(-1).sequence, received.at(-2).sequence + 1)
  for (let index = 1; index < received.length; index++)
    assert.ok(received[index].sequence > received[index - 1].sequence)
  const final = received.find((event) => event.type === 'message.completed')
  assert.equal(final.message.content, 'hello world')
  const snapshot = await (await request(`/conversations/${conversation.id}`)).json()
  assert.equal(snapshot.messages.length, 2)
  assert.equal(snapshot.messages[1].status, 'complete')
  assert.equal(snapshot.messages[1].content, 'hello world')
  const replay = []
  for await (const event of events(await request(`/runs/${run.id}/events`))) replay.push(event)
  assert.equal(replay.length, 1)
  assert.equal(replay[0].snapshot.run.status, 'completed')
})

test('same request is idempotent, different content conflicts and one run is active per conversation', async (t) => {
  const fake = engine({ interval: 90 })
  const { request } = await fixture(t, { engine: fake })
  const conversation = await create(request)
  const [first, second] = await Promise.all([
    start(request, conversation.id),
    start(request, conversation.id),
  ])
  assert.equal(first.id, second.id)
  assert.equal(fake.calls, 1)
  const changed = await request(`/conversations/${conversation.id}/runs`, {
    method: 'POST',
    body: { message: 'different', requestId: 'request-0001' },
  })
  assert.equal(changed.status, 409)
  assert.equal((await changed.json()).error.code, 'idempotency_conflict')
  assert.equal(
    (
      await request(`/conversations/${conversation.id}/runs`, {
        method: 'POST',
        body: { message: 'next', requestId: 'request-0002' },
      })
    ).status,
    409,
  )
  assert.equal(
    (await request(`/conversations/${conversation.id}`, { method: 'DELETE' })).status,
    409,
  )
  await settled(request, conversation.id)
  assert.equal((await start(request, conversation.id)).id, first.id)
  assert.equal(fake.calls, 1)
})

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

test('an old run stream preserves the current conversation snapshot and then closes', async (t) => {
  const fake = engine({ interval: 5 })
  const originalRun = fake.run
  let calls = 0
  let release
  const pending = new Promise((done) => {
    release = done
  })
  fake.run = async (input) => {
    if (calls++ === 0) return originalRun(input)
    input.onDelta('new output')
    await pending
    input.signal.throwIfAborted()
    return { text: 'new output complete' }
  }
  const { request } = await fixture(t, { engine: fake })
  const conversation = await create(request)
  const old = await start(request, conversation.id)
  await settled(request, conversation.id)
  const current = await start(request, conversation.id, 'request-current')
  try {
    const snapshot = await (await request(`/conversations/${conversation.id}`)).json()
    assert.equal(snapshot.run.id, current.id)
    assert.equal(snapshot.run.status, 'running')
    const received = []
    for await (const event of events(await request(`/runs/${old.id}/events`))) received.push(event)
    assert.equal(received.length, 1)
    assert.equal(received[0].type, 'snapshot')
    assert.equal(received[0].runId, old.id)
    assert.equal(received[0].sequence, snapshot.sequence)
    assert.deepEqual(received[0].snapshot, snapshot)
  } finally {
    release()
  }
  assert.equal((await settled(request, conversation.id)).run.status, 'completed')
})

test(
  'disconnecting during asynchronous SSE preparation releases the subscription without cancelling generation',
  { timeout: 10_000 },
  async (t) => {
    const { request, engine: fake } = await fixture(t, { engine: engine({ interval: 10_000 }) })
    const conversation = await create(request)
    const run = await start(request, conversation.id)
    const info = await fake.meta()
    const preparing = Promise.withResolvers()
    const resume = Promise.withResolvers()
    const disconnected = Promise.withResolvers()
    const unsubscribed = Promise.withResolvers()
    fake.meta = () => {
      preparing.resolve()
      return resume.promise
    }
    const emit = ServerResponse.prototype.emit
    t.mock.method(ServerResponse.prototype, 'emit', function (event, ...args) {
      const result = emit.call(this, event, ...args)
      if (event === 'close') disconnected.resolve()
      return result
    })
    const subscribe = ChatService.prototype.subscribe
    t.mock.method(ChatService.prototype, 'subscribe', async function (...args) {
      const result = await subscribe.apply(this, args)
      return {
        ...result,
        unsubscribe() {
          result.unsubscribe()
          unsubscribed.resolve()
        },
      }
    })
    const controller = new AbortController()
    const response = request(`/runs/${run.id}/events`, { signal: controller.signal }).catch(
      (error) => error,
    )
    await preparing.promise
    controller.abort()
    await response
    await disconnected.promise
    resume.resolve(info)
    await unsubscribed.promise
    fake.meta = () => Promise.resolve(info)
    assert.equal(
      (await (await request(`/conversations/${conversation.id}`)).json()).run.status,
      'running',
    )
  },
)

test('disconnecting an SSE consumer does not cancel work; reconnect returns a coherent snapshot', async (t) => {
  const { request } = await fixture(t, { engine: engine({ interval: 70 }) })
  const conversation = await create(request)
  const run = await start(request, conversation.id)
  const response = await request(`/runs/${run.id}/events`)
  const reader = response.body.getReader()
  await reader.read()
  await reader.cancel()
  const snapshot = await settled(request, conversation.id)
  assert.equal(snapshot.run.status, 'completed')
  assert.equal(snapshot.messages[1].content, 'hello world')
  const reconnected = []
  for await (const event of events(await request(`/runs/${run.id}/events`))) reconnected.push(event)
  assert.equal(reconnected[0].snapshot.sequence, snapshot.sequence)
})

test('cancel is idempotent, preserves partial text and permits a subsequent run', async (t) => {
  const { request } = await fixture(t, { engine: engine({ interval: 80 }) })
  const conversation = await create(request)
  const run = await start(request, conversation.id)
  for await (const event of events(await request(`/runs/${run.id}/events`))) {
    if (event.type === 'message.delta') break
  }
  assert.equal((await request(`/runs/${run.id}/cancel`, { method: 'POST' })).status, 200)
  const snapshot = await settled(request, conversation.id)
  assert.equal(snapshot.run.status, 'cancelled')
  assert.equal(snapshot.messages[1].status, 'interrupted')
  assert.equal(snapshot.messages[1].content, 'hello ')
  const again = await (await request(`/runs/${run.id}/cancel`, { method: 'POST' })).json()
  assert.equal(again.status, 'cancelled')
  const next = await start(request, conversation.id, 'request-next')
  assert.notEqual(next.id, run.id)
})

test('provider failure retains partial output without exposing private errors', async (t) => {
  const { request } = await fixture(t, { engine: engine({ fail: true }) })
  const conversation = await create(request)
  await start(request, conversation.id)
  const snapshot = await settled(request, conversation.id)
  assert.equal(snapshot.run.status, 'failed')
  assert.equal(snapshot.messages[1].status, 'interrupted')
  assert.equal(snapshot.messages[1].content, 'hello world')
  assert.ok(!JSON.stringify(snapshot).includes('private-provider-secret'))
})

test('an unconfigured engine rejects new runs before invoking the engine or persisting messages', async (t) => {
  const fake = engine()
  fake.meta = () =>
    Promise.resolve({
      engine: 'pi',
      model: { provider: 'unconfigured', id: 'unconfigured' },
      configured: false,
      capabilities: { tools: false },
    })
  const { request } = await fixture(t, { engine: fake })
  const conversation = await create(request)
  const response = await request(`/conversations/${conversation.id}/runs`, {
    method: 'POST',
    body: { message: 'hello', requestId: 'request-unconfigured' },
  })
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.code, 'engine_not_configured')
  const snapshot = await (await request(`/conversations/${conversation.id}`)).json()
  assert.equal(snapshot.run, null)
  assert.equal(snapshot.messages.length, 0)
  assert.equal(fake.calls, 0)
})

test('graceful service shutdown interrupts work and reopening never replays it', async (t) => {
  const service = await fixture(t, { engine: engine({ interval: 1000 }) })
  const conversation = await create(service.request)
  await start(service.request, conversation.id)
  await service.close()
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
