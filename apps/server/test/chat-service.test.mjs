import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { ChatService } from '../src/chat-service.ts'
import { ChatError } from '../src/errors.ts'
import { Store } from '../src/store.ts'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'learn-electron-chat-service-'))
  const store = new Store(join(directory, 'app.sqlite'))
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
  return { service, store, engine, calls, engineCloseCalls: () => closeCalls }
}

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
  const first = service.subscribe(run.id, {
    event: (event) => detached.push(event),
    close: () => {
      detachedClosed = true
    },
  })
  service.subscribe(run.id, {
    event: () => {
      throw new Error('observer failed')
    },
    close: (error) => observerErrors.push(error),
  })
  const second = service.subscribe(run.id, {
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
  const snapshot = service.getConversation(conversation.id)
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
  service.subscribe(run.id, { event: () => {}, close: ended.resolve })
  assert.equal(service.cancelRun(run.id).status, 'cancelling')
  assert.equal(await ended.promise, undefined)
  const cancelled = service.getConversation(conversation.id)
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
