import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { parseRun } from '@learn-electron/contracts'

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/features/chat/api.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [
    {
      name: 'test-platform',
      setup(builder) {
        builder.onResolve({ filter: /^@\/platform$/ }, () => ({
          path: 'platform',
          namespace: 'test',
        }))
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: "export const platform = { apiBaseUrl: '' }",
        }))
      },
    },
  ],
})
const { request, readRunEvents, ProtocolError, ApiRequestError } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)
const timestamp = '2026-01-01T00:00:00.000Z'
const conversation = {
  id: 'conversation-1',
  title: 'Large history',
  createdAt: timestamp,
  updatedAt: timestamp,
}
const run = {
  id: 'run-1',
  conversationId: conversation.id,
  status: 'running',
  createdAt: timestamp,
  updatedAt: timestamp,
}

test('large SSE snapshots decode identically across network and UTF-8 boundaries', async (t) => {
  const snapshot = {
    conversation,
    messages: [1, 2].map((id) => ({
      id: `message-${id}`,
      role: 'assistant',
      content: '你'.repeat(600_000),
      createdAt: timestamp,
      status: 'complete',
    })),
    run,
    sequence: 10,
  }
  const base = { apiVersion: 1, conversationId: conversation.id, runId: run.id }
  const events = [
    { ...base, type: 'snapshot', snapshot, sequence: 10 },
    { ...base, type: 'run.updated', run: { ...run, status: 'completed' }, sequence: 11 },
  ]
  const bytes = new TextEncoder().encode(
    events
      .map((event) => `id: ${event.sequence}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`)
      .join(''),
  )
  const mocked = t.mock.method(globalThis, 'fetch')
  for (const size of [bytes.length, 65_536]) {
    mocked.mock.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let offset = 0; offset < bytes.length; offset += size)
                controller.enqueue(bytes.subarray(offset, offset + size))
              controller.close()
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    )
    const received = []
    assert.equal(
      await readRunEvents(run.id, new AbortController().signal, (event) => received.push(event)),
      true,
    )
    assert.deepEqual(received, events)
  }
})

test('HTTP responses use the decoder and reject malformed successful bodies', async (t) => {
  const responses = [
    Response.json(run),
    Response.json({ ...run, status: 'unknown' }),
    new Response('invalid JSON'),
    new Response(null, { status: 204 }),
  ]
  t.mock.method(globalThis, 'fetch', async () => responses.shift())
  assert.deepEqual(await request('/runs/run-1', parseRun), run)
  await assert.rejects(request('/runs/run-1', parseRun), ProtocolError)
  await assert.rejects(request('/runs/run-1', parseRun), ProtocolError)
  assert.equal(
    await request('/conversations/conversation-1', undefined, { method: 'DELETE' }),
    undefined,
  )
})

test('HTTP and SSE preserve structured errors and tolerate proxy error pages', async (t) => {
  const responses = [
    Response.json({ error: { code: 'shutting_down', message: '服务正在停止' } }, { status: 503 }),
    Response.json({ error: { code: 'unauthorized', message: '需要有效令牌' } }, { status: 401 }),
    new Response('<html>Bad Gateway</html>', { status: 502 }),
  ]
  t.mock.method(globalThis, 'fetch', async () => responses.shift())
  await assert.rejects(request('/meta', parseRun), (error) => {
    assert.ok(error instanceof ApiRequestError)
    assert.equal(error.status, 503)
    assert.equal(error.code, 'shutting_down')
    assert.equal(error.message, '服务正在停止')
    return true
  })
  await assert.rejects(
    readRunEvents(run.id, new AbortController().signal, () => {}),
    (error) => {
      assert.ok(error instanceof ApiRequestError)
      assert.equal(error.status, 401)
      assert.equal(error.code, 'unauthorized')
      assert.equal(error.message, '需要有效令牌')
      return true
    },
  )
  await assert.rejects(request('/meta', parseRun), (error) => {
    assert.ok(error instanceof ApiRequestError)
    assert.equal(error.status, 502)
    assert.equal(error.code, undefined)
    assert.ok(error.message && !error.message.includes('<html>'))
    return true
  })
})
