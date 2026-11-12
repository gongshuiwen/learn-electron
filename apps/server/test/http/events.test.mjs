import assert from 'node:assert/strict'
import { ServerResponse } from 'node:http'
import test from 'node:test'
import { ChatService } from '../../src/chat-service.ts'
import { create, engine, events, fixture, settled, start } from '../helpers/server.mjs'

test('real HTTP/SSE streams snapshot, ordered deltas, final message and terminal run', async (t) => {
  const { request } = await fixture(t)
  const conversation = await create(request)
  const run = await start(request, conversation.id)
  const received = []
  const response = await request(`/runs/${run.id}/events`)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('x-accel-buffering'), 'no')
  for await (const event of events(response)) received.push(event)
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
