import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { startServer } from '../src/server.ts'
import { oauthFixture } from './helpers/chatgpt.mjs'

test(
  'HTTP OAuth → real Pi → Responses → SSE survives restart and never falls back to an API key',
  { timeout: 40_000 },
  async (t) => {
    const remote = await oauthFixture(t)
    const originalFetch = globalThis.fetch
    const oldKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-must-not-use-this-key'
    t.mock.method(globalThis, 'fetch', (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      )
      if (url.origin === 'https://api.openai.com')
        return originalFetch(`${remote.issuer}${url.pathname}${url.search}`, init)
      return originalFetch(input, init)
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-oauth-pi-'))
    const options = {
      token: 'test-local-service-token',
      dataDir,
      authMode: 'chatgpt',
      chatgptOAuth: remote.oauth,
    }
    let backend = await startServer(options)
    t.after(async () => {
      await backend.close()
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = oldKey
      assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()))
      await rm(dataDir, { recursive: true, force: true })
    })
    async function request(path, method = 'GET', body) {
      return fetch(`${backend.url}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${options.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    }
    assert.equal((await fetch(`${backend.url}/api/v1/auth/chatgpt`)).status, 401)
    assert.equal((await (await request('/meta')).json()).configured, false)
    assert.equal(remote.calls, 0)
    const attempt = await (await request('/auth/chatgpt/login', 'POST', {})).json()
    await remote.authorize(attempt)
    for (let i = 0; i < 100; i++) {
      const status = await (await request(`/auth/chatgpt/logins/${attempt.id}`)).json()
      if (status.status !== 'pending') {
        assert.equal(status.status, 'completed', status.error)
        break
      }
      await delay(20)
    }
    const meta = await (await request('/meta')).json()
    assert.equal(meta.configured, true)
    assert.equal(meta.authMode, 'chatgpt')
    assert.equal(meta.model.provider, 'openai')
    assert.equal((await (await request('/models')).json()).length, 1)
    const conversation = await (await request('/conversations', 'POST')).json()
    async function send(message, id = conversation.id) {
      const response = await request(`/conversations/${id}/runs`, 'POST', {
        message,
        requestId: crypto.randomUUID(),
      })
      assert.equal(response.status, 202, await response.clone().text())
      const run = await response.json()
      const stream = await request(`/runs/${run.id}/events`)
      assert.equal(stream.status, 200)
      const text = await stream.text()
      assert.match(text, /message.completed/)
      return await (await request(`/conversations/${id}`)).json()
    }
    const first = await send('你好，请记住这个问候')
    assert.equal(first.run.status, 'completed', first.run.error)
    assert.equal(first.messages[1].content, '你好，我记住了。')
    await backend.close()
    backend = await startServer(options)
    assert.equal((await (await request('/meta')).json()).configured, true)
    const second = await send('我刚才说了什么？')
    assert.equal(second.run.status, 'completed', second.run.error)
    assert.match(JSON.stringify(remote.requests[1].body.input), /你好，请记住这个问候/)
    assert.match(JSON.stringify(remote.requests[1].body.input), /你好，我记住了/)
    for (const wire of remote.requests) {
      assert.match(wire.authorization, /^Bearer plan-access-/)
      assert.equal(wire.body.store, false)
      assert.equal(wire.body.stream, true)
      for (const name of [
        'temperature',
        'max_output_tokens',
        'previous_response_id',
        'prompt_cache_retention',
      ])
        assert.equal(name in wire.body, false)
      assert.ok(!wire.body.input.some((item) => item.role === 'system'))
      assert.ok(!wire.body.tools?.length)
    }
    remote.responseError = 'subscription_sharing_usage_limit_exceeded'
    const failed = await send('测试用量不足')
    assert.equal(failed.run.status, 'failed')
    assert.equal(failed.run.errorCode, 'quota_exceeded')
    assert.doesNotMatch(failed.run.error, /plan-access|sk-must-not/)
    remote.responseError = 'incomplete'
    const incomplete = await send('测试截断流')
    assert.equal(incomplete.run.status, 'failed')
    assert.equal(incomplete.messages.at(-1).status, 'interrupted')
    assert.ok(incomplete.messages.at(-1).content.length > 0)
    remote.responseError = null
    assert.deepEqual(await (await request('/auth/chatgpt/logout', 'POST')).json(), {
      revoked: true,
    })
    assert.equal((await (await request('/meta')).json()).configured, false)
    assert.equal(remote.calls, 4)
    const another = await (await request('/auth/chatgpt/login', 'POST', {})).json()
    await remote.authorize(another, { subject: 'another-account' })
    for (let i = 0; i < 100 && !(await (await request('/meta')).json()).configured; i++)
      await delay(20)
    const denied = await request(`/conversations/${conversation.id}/runs`, 'POST', {
      message: '不应跨账号发送',
      requestId: 'cross-account-test',
    })
    assert.equal(denied.status, 409)
    assert.equal((await denied.json()).error.code, 'connection_changed')
    assert.equal(remote.calls, 4)
  },
)
