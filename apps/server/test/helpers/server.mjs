import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startServer } from '../../src/server.ts'
import { schemaValidators } from '@learn-electron/contracts/validation'
import { assertApiResponse } from './contracts.mjs'

export const TOKEN = 'integration-test-secret-token'

export function engine({ chunks = ['hello ', 'world'], interval = 25, fail = false } = {}) {
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

export async function fixture(t, options = {}) {
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

export function client(url) {
  return async (path, options = {}) => {
    const { body, headers, ...rest } = options
    const response = await fetch(`${url}/api/v1${path}`, {
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
    return assertApiResponse(response, path, options.method ?? 'GET')
  }
}

export async function create(request) {
  const response = await request('/conversations', { method: 'POST' })
  assert.equal(response.status, 201)
  return response.json()
}

export async function start(request, id, requestId = 'request-0001', message = 'hello') {
  const response = await request(`/conversations/${id}/runs`, {
    method: 'POST',
    body: { message, requestId },
  })
  assert.equal(response.status, 202)
  return response.json()
}

export async function* events(response) {
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
      const lines = frame.split('\n')
      const data = lines.find((line) => line.startsWith('data: '))
      if (data) {
        const event = JSON.parse(data.slice(6))
        assert.equal(
          schemaValidators.RunEvent(event),
          true,
          'SSE data must satisfy OpenAPI RunEvent',
        )
        assert.equal(
          lines.find((line) => line.startsWith('id: ')),
          `id: ${event.sequence}`,
        )
        yield event
      }
    }
  }
}

export async function settled(request, conversationId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = await (await request(`/conversations/${conversationId}`)).json()
    if (!['running', 'cancelling'].includes(snapshot.run?.status)) return snapshot
    await delay(10)
  }
  throw new Error('Run did not settle')
}
