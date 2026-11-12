import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import test from 'node:test'
import { startServer } from '../../src/server.ts'
import { createHttpServer } from '../../src/http/index.ts'
import { TOKEN, create, engine, fixture, start } from '../helpers/server.mjs'

test('loopback API requires authentication and validates Host, Origin and CORS', async (t) => {
  const service = await fixture(t)
  const { url, request } = service
  assert.equal((await fetch(`${url}/api/v1/meta`)).status, 401)
  assert.equal((await request('/meta', { headers: { Authorization: 'Bearer wrong' } })).status, 401)
  const forgedHost = await new Promise((resolveResponse, rejectResponse) => {
    const raw = httpRequest(
      `${url}/api/v1/meta`,
      { headers: { Host: 'attacker.invalid', Authorization: 'Bearer wrong' } },
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
  const unknownPreflight = await fetch(`${url}/api/v1/unknown`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', Authorization: 'Bearer wrong' },
  })
  assert.equal(unknownPreflight.status, 204)
  assert.equal(unknownPreflight.headers.get('cache-control'), 'no-store')
  assert.equal(unknownPreflight.headers.get('x-content-type-options'), 'nosniff')
  const rejectedOrigin = await fetch(`${url}/api/v1/meta`, {
    headers: { Origin: 'https://attacker.invalid', Authorization: 'Bearer wrong' },
  })
  assert.equal(rejectedOrigin.status, 403)
  assert.equal((await rejectedOrigin.json()).error.code, 'invalid_origin')
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

test('routing and request-body handling preserve method and error precedence', async (t) => {
  const { url, request } = await fixture(t, { engine: engine({ interval: 500 }) })
  const conversation = await create(request)
  const run = await start(request, conversation.id)

  const unauthorized = await fetch(`${url}/api/v1/conversations/${conversation.id}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
    body: '{',
  })
  assert.equal(unauthorized.status, 401)
  assert.equal((await unauthorized.json()).error.code, 'unauthorized')

  const disabled = await request('/model-providers', { method: 'POST', body: '{' })
  assert.equal(disabled.status, 409)
  assert.equal((await disabled.json()).error.code, 'engine_disabled')
  const disabledWithInvalidType = await request('/model-providers', {
    method: 'POST',
    headers: { 'Content-Type': 'bad media type' },
    body: '{',
  })
  assert.equal(disabledWithInvalidType.status, 409)
  assert.equal((await disabledWithInvalidType.json()).error.code, 'engine_disabled')
  assert.equal((await request('/meta', { method: 'HEAD' })).status, 404)
  assert.equal((await request(`/conversations/${conversation.id}/runs`)).status, 405)
  assert.equal((await request(`/runs/${run.id}/cancel`)).status, 405)
  const unknownRun = await request('/runs/unknown/cancel')
  assert.equal(unknownRun.status, 404)
  assert.equal((await unknownRun.json()).error.code, 'run_not_found')
  assert.equal((await request(`/conversations/%${conversation.id}`)).status, 404)
  assert.equal((await request('/%6deta')).status, 404)
  assert.equal((await request('/model%2dproviders')).status, 404)
  assert.equal((await request('/conversations', { method: 'PROPFIND' })).status, 405)
  assert.equal((await request('/model-providers', { method: 'PROPFIND' })).status, 409)
  assert.equal((await request('/unknown', { method: 'PROPFIND' })).status, 404)
  assert.equal((await request('/%')).status, 404)
  assert.equal((await request('/%FF')).status, 404)
  assert.equal(
    (await fetch(`${url}/api/v1/%`, { headers: { Authorization: 'Bearer wrong' } })).status,
    401,
  )
  assert.equal((await fetch(`${url}/api/v1/%`, { method: 'OPTIONS' })).status, 204)

  const cancelled = await request(`/runs/${run.id}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'bad media type' },
    body: '{',
  })
  assert.equal(cancelled.status, 200)
  assert.ok(['cancelling', 'cancelled'].includes((await cancelled.json()).status))
})

test('other Fastify routes decode path parameters without changing v1 matching', async (t) => {
  const app = createHttpServer({
    token: TOKEN,
    allowedOrigins: [],
    isClosing: () => false,
    chat: {},
    engine: engine(),
    models: undefined,
    chatgpt: undefined,
  })
  app.get('/other/:name', async (request) => request.params)
  t.after(() => app.close())
  const url = await app.listen({ port: 0, host: '127.0.0.1' })
  const response = await fetch(`${url}/other/hello%20world`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { name: 'hello world' })
})
