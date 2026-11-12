import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { getOpenAIModels } from '@learn-electron/agent-runtime'
import { oauthFixture as authFixture } from '../../../../packages/chatgpt-auth/test/helpers/oauth.mjs'

export { finishLogin } from '../../../../packages/chatgpt-auth/test/helpers/oauth.mjs'

export async function oauthFixture(t) {
  const fixture = await authFixture(t, {
    modelId: (await getOpenAIModels())[0].id,
    async handleRequest(request, response, body) {
      if (new URL(request.url, fixture.issuer).pathname !== '/v1/responses') return false
      fixture.calls++
      fixture.requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(body),
      })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const emit = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`)
      const item = {
        id: randomUUID(),
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      }
      emit({ type: 'response.output_item.added', output_index: 0, item })
      const text = fixture.calls === 1 ? '你好，我记住了。' : '你刚才说了你好。'
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
      if (fixture.holdResponse) {
        fixture.responseGate = Promise.withResolvers()
        await Promise.race([fixture.responseGate.promise, once(response, 'close')])
        if (response.destroyed) return true
      }
      if (fixture.responseError === 'incomplete')
        emit({
          type: 'response.incomplete',
          response: {
            id: randomUUID(),
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [],
          },
        })
      else if (fixture.responseError)
        emit({
          type: 'response.failed',
          response: { error: { code: fixture.responseError, message: fixture.responseError } },
        })
      else {
        const completed = {
          ...item,
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        }
        emit({ type: 'response.output_item.done', output_index: 0, item: completed })
        emit({
          type: 'response.completed',
          response: {
            id: randomUUID(),
            status: 'completed',
            output: [completed],
            usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
          },
        })
      }
      response.end()
      return true
    },
  })
  return Object.assign(fixture, {
    calls: 0,
    requests: [],
    responseError: null,
    holdResponse: false,
    responseGate: null,
  })
}
