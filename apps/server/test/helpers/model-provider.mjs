import { createServer } from 'node:http'
import { once } from 'node:events'

/** Real local wire protocols; no SDK/session mocks. Shared with browser acceptance. */
export async function modelProvider(t) {
  const remote = {
    requests: [],
    calls: 0,
    hold: false,
    gate: null,
    holdCatalog: false,
    catalogStarted: Promise.withResolvers(),
    catalogGate: null,
    status: 200,
    url: '',
  }
  const server = createServer((request, response) => {
    remote.calls++
    void (async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString()
      const path = new URL(request.url, remote.url).pathname
      if (request.method === 'GET' && path.endsWith('/models')) {
        if (remote.holdCatalog) {
          remote.catalogGate = Promise.withResolvers()
          remote.catalogStarted.resolve()
          await Promise.race([remote.catalogGate.promise, once(response, 'close')])
          if (response.destroyed) return
        }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            data: [{ id: 'discovered-model', inputTokenLimit: 65536, outputTokenLimit: 8192 }],
            models: [
              { name: 'models/discovered-model', supportedGenerationMethods: ['generateContent'] },
            ],
          }),
        )
        return
      }
      remote.requests.push({ headers: request.headers, path, body: JSON.parse(body) })
      if (remote.status !== 200) {
        response.writeHead(remote.status, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            error: {
              message: 'private-upstream-secret',
              type:
                remote.status === 429
                  ? 'rate_limit_exceeded'
                  : remote.status === 404
                    ? 'model_not_found'
                    : 'invalid_api_key',
            },
          }),
        )
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const emit = (data, event) =>
        response.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
      const text = 'Provider reply'
      if (path.endsWith('/chat/completions')) {
        const chunk = {
          id: 'chat-fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'custom-model',
        }
        emit({
          ...chunk,
          choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
        })
        if (remote.hold) {
          remote.gate = Promise.withResolvers()
          await Promise.race([remote.gate.promise, once(response, 'close')])
          if (response.destroyed) return
        }
        emit({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        response.write('data: [DONE]\n\n')
      } else if (path.endsWith('/responses')) {
        const item = {
          id: 'message-fixture',
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        }
        emit({ type: 'response.output_item.added', output_index: 0, item })
        emit({
          type: 'response.content_part.added',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        })
        emit({
          type: 'response.output_text.delta',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: text,
        })
        const completed = {
          ...item,
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        }
        emit({ type: 'response.output_item.done', output_index: 0, item: completed })
        emit({
          type: 'response.completed',
          response: {
            id: 'response-fixture',
            status: 'completed',
            output: [completed],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          },
        })
      } else if (path.endsWith('/messages')) {
        emit(
          {
            type: 'message_start',
            message: {
              id: 'anthropic-fixture',
              type: 'message',
              role: 'assistant',
              model: 'custom-model',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          'message_start',
        )
        emit(
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          'content_block_start',
        )
        emit(
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
          'content_block_delta',
        )
        emit({ type: 'content_block_stop', index: 0 }, 'content_block_stop')
        emit(
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 2 },
          },
          'message_delta',
        )
        emit({ type: 'message_stop' }, 'message_stop')
      } else if (path.includes(':streamGenerateContent')) {
        emit({
          candidates: [
            { content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP', index: 0 },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
        })
      } else throw new Error(`Unexpected model route: ${path}`)
      response.end()
    })().catch((error) => response.destroy(error))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  remote.url = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    remote.gate?.resolve()
    remote.catalogGate?.resolve()
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  })
  return remote
}
