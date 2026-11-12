import assert from 'node:assert/strict'
import test from 'node:test'
import { create, engine, events, fixture, settled, start } from '../helpers/server.mjs'

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
  const prefix = '{"title":"Boundary","padding":"'
  const suffix = '"}'
  const boundary = prefix + 'x'.repeat(160 * 1024 - prefix.length - suffix.length) + suffix
  assert.equal(
    (await request(`/conversations/${conversation.id}`, { method: 'PATCH', body: boundary }))
      .status,
    200,
  )
  const tooLarge = await request(`/conversations/${conversation.id}`, {
    method: 'PATCH',
    body: boundary.replace(suffix, `x${suffix}`),
  })
  assert.equal(tooLarge.status, 413)
  assert.equal((await tooLarge.json()).error.code, 'body_too_large')
  assert.equal(
    (await request(`/conversations/${conversation.id}`, { method: 'DELETE' })).status,
    204,
  )
  assert.equal((await request(`/conversations/${conversation.id}`)).status, 404)
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
