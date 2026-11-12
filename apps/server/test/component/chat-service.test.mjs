import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { ChatService } from '../../src/chat-service.ts'
import { ChatError } from '../../src/errors.ts'
import { Store } from '../../src/store.ts'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'learn-electron-chat-service-'))
  const databasePath = join(directory, 'app.sqlite')
  const store = new Store(databasePath)
  const calls = []
  let closeCalls = 0
  const engine = {
    meta: () =>
      Promise.resolve({
        engine: 'mock',
        model: { provider: 'test', id: 'controlled' },
        configured: true,
        capabilities: { tools: false },
      }),
    run(input) {
      const pending = new Promise((done, reject) => {
        const abort = () => reject(input.signal.reason)
        input.signal.addEventListener('abort', abort, { once: true })
        calls.push({
          input,
          finish(text) {
            input.signal.removeEventListener('abort', abort)
            done({ text })
          },
        })
      })
      input.onDelta('partial')
      return pending
    },
    close() {
      closeCalls++
      return Promise.resolve()
    },
  }
  const service = new ChatService(store, engine)
  t.after(async () => {
    try {
      await service.close()
    } finally {
      await engine.close()
      store.close()
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('learn-electron-chat-service-'))
      await rm(directory, { recursive: true, force: true })
    }
  })
  return { service, store, engine, calls, databasePath, engineCloseCalls: () => closeCalls }
}

test('a concurrent first run cannot bind a superseded model selection', async (t) => {
  const store = new Store(':memory:')
  const first = { instanceId: 'first', modelId: 'model-a' }
  const second = { instanceId: 'second', modelId: 'model-b' }
  const calls = []
  const engine = {
    run: async ({ target }) => {
      calls.push(target.instanceId)
      return { text: 'done' }
    },
    close: async () => {},
  }
  const models = {
    defaultSelection: () => first,
    statusFor: (selection, binding) => ({
      selection,
      target: binding ?? selection,
      model: { provider: (binding ?? selection).instanceId, id: (binding ?? selection).modelId },
      configured: true,
    }),
    resolve: (ref) => ({
      ...ref,
      kind: 'endpoint',
      revision: 1,
      provider: ref.instanceId,
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:1',
      authentication: 'none',
      compatibility: {},
      model: { id: ref.modelId, name: ref.modelId, contextWindow: 32768, maxOutputTokens: 4096 },
    }),
  }
  const service = new ChatService(store, engine, models)
  t.after(async () => {
    await service.close()
    store.close()
  })
  const conversation = service.createConversation(first)
  const rejected = assert.rejects(
    service.startRun(conversation.id, {
      message: 'first',
      requestId: 'race-request-1',
      expectedTarget: first,
    }),
    { code: 'connection_changed' },
  )
  const previousSnapshot = service.getConversation(conversation.id)
  const chosen = service.selectConversationModel(conversation.id, second)
  const snapshot = await previousSnapshot
  assert.deepEqual(snapshot.conversation.selection, first)
  assert.deepEqual(snapshot.model.target, first)
  await rejected
  await chosen
  assert.deepEqual(store.snapshot(conversation.id).conversation.selection, second)
  assert.equal(store.snapshot(conversation.id).conversation.binding, undefined)
  assert.equal(store.snapshot(conversation.id).messages.length, 0)
  assert.deepEqual(calls, [])
  for (const expectedTarget of [first, undefined]) {
    await assert.rejects(
      service.startRun(conversation.id, {
        message: 'stale client',
        requestId: 'race-request-stale',
        expectedTarget,
      }),
      { code: 'connection_changed' },
    )
  }
  const run = await service.startRun(conversation.id, {
    message: 'second',
    requestId: 'race-request-2',
    expectedTarget: second,
  })
  assert.deepEqual(run.target, second)
  assert.deepEqual(calls, ['second'])
  const replay = await service.startRun(conversation.id, {
    message: 'second',
    requestId: 'race-request-2',
    expectedTarget: first,
  })
  assert.equal(replay.id, run.id)
  assert.deepEqual(calls, ['second'])
})

test('chat runs without HTTP and isolates detached or failing observers', async (t) => {
  const { service, calls } = await fixture(t)
  const conversation = service.createConversation()
  const request = { message: 'hello', requestId: 'service-request-1' }
  const run = await service.startRun(conversation.id, request)
  const detached = []
  const observerErrors = []
  const received = []
  const ended = deferred()
  let detachedClosed = false
  const first = await service.subscribe(run.id, {
    event: (event) => detached.push(event),
    close: () => {
      detachedClosed = true
    },
  })
  await service.subscribe(run.id, {
    event: () => {
      throw new Error('observer failed')
    },
    close: (error) => observerErrors.push(error),
  })
  const second = await service.subscribe(run.id, {
    event: (event) => received.push(event),
    close: ended.resolve,
  })
  assert.equal(second.active, true)
  assert.equal(second.snapshot.snapshot.messages[1].content, 'partial')
  first.unsubscribe()
  first.unsubscribe()
  calls[0].input.onDelta(' streamed')
  calls[0].finish('final response')
  assert.equal(await ended.promise, undefined)

  assert.deepEqual(detached, [])
  assert.equal(detachedClosed, false)
  assert.equal(observerErrors.length, 1)
  assert.ok(observerErrors[0] instanceof Error)
  assert.deepEqual(
    received.map((event) => event.type),
    ['message.delta', 'message.completed', 'run.updated'],
  )
  assert.equal(received.at(-1).sequence, received.at(-2).sequence + 1)
  const snapshot = await service.getConversation(conversation.id)
  assert.equal(snapshot.messages[1].content, 'final response')
  assert.equal(snapshot.run.status, 'completed')
  assert.equal((await service.startRun(conversation.id, request)).id, run.id)
  assert.equal(calls.length, 1)
  second.unsubscribe()
})

test('chat cancellation preserves partial text and closing drains work and deletion', async (t) => {
  const { service, store, engine, engineCloseCalls } = await fixture(t)
  const conversation = service.createConversation()
  const run = await service.startRun(conversation.id, {
    message: 'cancel me',
    requestId: 'service-request-2',
  })
  const ended = deferred()
  await service.subscribe(run.id, { event: () => {}, close: ended.resolve })
  assert.equal(service.cancelRun(run.id).status, 'cancelling')
  assert.equal(await ended.promise, undefined)
  const cancelled = await service.getConversation(conversation.id)
  assert.equal(cancelled.run.status, 'cancelled')
  assert.equal(cancelled.messages[1].content, 'partial')
  assert.equal(cancelled.messages[1].status, 'interrupted')
  assert.throws(
    () => service.cancelRun('missing-run'),
    (error) => error instanceof ChatError && error.code === 'run_not_found' && !('status' in error),
  )

  await service.startRun(conversation.id, {
    message: 'interrupt me',
    requestId: 'service-request-3',
  })
  const discarded = service.createConversation()
  const deletionGate = deferred()
  engine.deleteConversation = () => deletionGate.promise
  const deletion = service.deleteConversation(discarded.id)
  let closed = false
  const closing = service.close().then(() => {
    closed = true
  })
  try {
    await setImmediate()
    assert.equal(closed, false, 'close must wait before the owner can release its store and lease')
  } finally {
    deletionGate.resolve()
  }
  await Promise.all([deletion, closing])
  assert.throws(() => store.snapshot(discarded.id), { code: 'conversation_not_found' })
  assert.equal(store.snapshot(conversation.id).run.status, 'interrupted')
  assert.equal(engineCloseCalls(), 0)
  await assert.rejects(
    service.startRun(conversation.id, { message: 'too late', requestId: 'service-request-4' }),
    (error) => error instanceof ChatError && error.code === 'shutting_down',
  )
})

test('a run finishing during asynchronous snapshot preparation cannot leave an active SSE subscription', async (t) => {
  const { service, calls, engine } = await fixture(t)
  const conversation = service.createConversation()
  const run = await service.startRun(conversation.id, {
    message: 'finish while subscribing',
    requestId: 'subscribe-preparation',
  })
  const meta = await engine.meta()
  const preparing = Promise.withResolvers()
  engine.meta = () => preparing.promise
  const subscription = service.subscribe(run.id, {
    event() {
      assert.fail('finished run must use the snapshot')
    },
    close() {},
  })
  calls[0].finish('completed before subscription')
  await setImmediate()
  preparing.resolve(meta)
  const result = await subscription
  assert.equal(result.active, false)
  assert.equal(result.snapshot.snapshot.run.status, 'completed')
  assert.equal(result.snapshot.snapshot.messages[1].content, 'completed before subscription')
  result.unsubscribe()
})

test('terminal write retries stay within their conversation and never rerun the model', async (t) => {
  const { service, store, calls, databasePath } = await fixture(t)
  const conversation = service.createConversation()
  const request = { message: 'hello', requestId: 'retry-finalization' }
  const run = await service.startRun(conversation.id, request)
  const other = service.createConversation()
  const otherRun = await service.startRun(other.id, {
    message: 'cancel during storage outage',
    requestId: 'outage-cancellation',
  })
  const ended = deferred()
  await service.subscribe(run.id, { event() {}, close: ended.resolve })
  const control = new DatabaseSync(databasePath)
  try {
    control.exec(`CREATE TRIGGER reject_finalize BEFORE UPDATE OF sequence ON conversations
      BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;`)
    calls[0].finish('complete response')
    assert.ok((await ended.promise) instanceof Error)
    assert.equal(store.getRun(run.id).status, 'running')
    assert.equal((await service.meta()).configured, true)
    assert.equal(service.listConversations().length, 2)
    assert.equal((await service.getConversation(other.id)).run.id, otherRun.id)
    assert.equal(service.getRun(otherRun.id).status, 'running')
    await assert.rejects(service.getConversation(conversation.id), { code: 'storage_unavailable' })
    assert.throws(() => service.cancelRun(run.id), { code: 'storage_unavailable' })
    await assert.rejects(service.startRun(conversation.id, request), {
      code: 'storage_unavailable',
    })
    assert.throws(() => service.cancelRun(otherRun.id), /injected write failure/)
    assert.equal(calls[1].input.signal.aborted, true)
    await setImmediate()

    control.exec('DROP TRIGGER reject_finalize')
    assert.equal(service.cancelRun(run.id).status, 'completed')
    assert.equal(service.getRun(otherRun.id).status, 'cancelled')
    assert.equal(
      (await service.getConversation(conversation.id)).messages[1].content,
      'complete response',
    )
    assert.equal((await service.startRun(conversation.id, request)).id, run.id)
    assert.equal(calls.length, 2)

    const next = await service.startRun(conversation.id, {
      message: 'continue',
      requestId: 'after-finalization',
    })
    calls[2].finish('next response')
    await setImmediate()
    assert.equal(service.getRun(next.id).status, 'completed')
  } finally {
    control.exec('DROP TRIGGER IF EXISTS reject_finalize')
    control.close()
  }
})
