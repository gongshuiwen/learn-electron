import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { startServer } from '../src/server.ts'
import { ProtectedFile } from '../src/protected-file.ts'
import { oauthFixture } from './helpers/chatgpt.mjs'

test(
  'HTTP OAuth and explicit model selection preserve Pi context across restart and account changes without API-key fallback',
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
      return url.origin === 'https://api.openai.com'
        ? originalFetch(`${remote.issuer}${url.pathname}${url.search}`, init)
        : originalFetch(input, init)
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-oauth-pi-'))
    const options = { token: 'test-local-service-token', dataDir, chatgptOAuth: remote.oauth }
    let backend
    let starting = startServer(options).then((server) => {
      backend = server
    })
    t.after(async () => {
      await starting.catch(() => {})
      await backend?.close()
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = oldKey
      assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()))
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
    })
    await starting
    t.signal.throwIfAborted()
    function request(path, method = 'GET', body) {
      return fetch(`${backend.url}/api/v1${path}`, {
        method,
        signal: t.signal,
        headers: {
          Authorization: `Bearer ${options.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    }
    async function login(subject) {
      const providers = await (
        await request('/model-providers', 'POST', { kind: 'chatgpt' })
      ).json()
      const attempt = await (
        await request(`/model-providers/${providers.instances.at(-1).id}/auth/attempts`, 'POST')
      ).json()
      await remote.authorize(attempt, subject ? { subject } : {})
      for (let i = 0; i < 100; i++) {
        const status = await (await request(`/model-auth-attempts/${attempt.id}`)).json()
        if (status.status !== 'pending') {
          assert.equal(status.status, 'completed', status.error)
          assert.ok(status.instanceId)
          return status.instanceId
        }
        await delay(20)
      }
      assert.fail('Login did not finish')
    }
    assert.equal((await fetch(`${backend.url}/api/v1/model-providers`)).status, 401)
    assert.equal((await (await request('/meta')).json()).configured, false)
    assert.equal(remote.calls, 0)
    const accountId = await login()
    assert.equal((await (await request('/model-providers')).json()).defaultSelection, null)
    assert.equal(
      (await (await request('/meta')).json()).configured,
      false,
      'Login alone does not select an account',
    )
    assert.equal((await (await request(`/model-providers/${accountId}/models`)).json()).length, 1)
    assert.equal(
      (await request(`/model-providers/${accountId}/models/refresh`, 'POST')).status,
      200,
    )
    assert.equal(
      (
        await request('/model', 'PUT', {
          instanceId: accountId,
          modelId: remote.modelId,
        })
      ).status,
      200,
    )
    const meta = await (await request('/meta')).json()
    assert.equal(meta.configured, true)
    assert.equal(meta.authMode, 'chatgpt')
    assert.equal(meta.model.provider, `ChatGPT · test@example.com · ${accountId.slice(0, 8)}`)
    const invalidModel = await request('/model', 'PUT', {
      instanceId: accountId,
      modelId: 'unknown-to-pi',
    })
    assert.equal(invalidModel.status, 400)
    assert.equal((await invalidModel.json()).error.code, 'model_unavailable')
    assert.deepEqual(await (await request('/meta')).json(), meta)
    const conversation = await (await request('/conversations', 'POST')).json()
    async function send(message, conversationId = conversation.id) {
      const expectedTarget = (await (await request(`/conversations/${conversationId}`)).json())
        .model.target
      const response = await request(`/conversations/${conversationId}/runs`, 'POST', {
        message,
        requestId: crypto.randomUUID(),
        expectedTarget,
      })
      assert.equal(response.status, 202, await response.clone().text())
      const run = await response.json()
      const stream = await request(`/runs/${run.id}/events`)
      assert.equal(stream.status, 200)
      assert.match(await stream.text(), /message.completed/)
      return (await request(`/conversations/${conversationId}`)).json()
    }
    const first = await send('你好，请记住这个问候')
    assert.equal(first.run.status, 'completed', first.run.error)
    assert.equal(first.messages[1].content, '你好，我记住了。')
    t.signal.throwIfAborted()
    starting = (async () => {
      await backend.close()
      t.signal.throwIfAborted()
      backend = await startServer(options)
    })()
    await starting
    t.signal.throwIfAborted()
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
    const anotherId = await login('another-account')
    const accounts = (await (await request('/model-providers')).json()).instances
    const firstAccount = accounts.find(({ id }) => id === accountId)
    const anotherAccount = accounts.find(({ id }) => id === anotherId)
    assert.notEqual(firstAccount.name, anotherAccount.name)
    assert.match(firstAccount.name, /test@example.com/)
    assert.match(anotherAccount.name, /test@example.com/)
    assert.equal(
      (await (await request('/model-providers')).json()).defaultSelection.instanceId,
      accountId,
    )
    assert.equal((await (await request(`/model-providers/${anotherId}/models`)).json()).length, 1)
    const conversationsBeforeProbe = await (await request('/conversations')).json()
    remote.holdResponse = true
    const probe = request(`/model-providers/${anotherId}/test`, 'POST', { modelId: remote.modelId })
    try {
      for (let i = 0; i < 200 && !remote.responseGate; i++) await delay(10)
      assert.ok(remote.responseGate)
      assert.equal(
        (await request(`/model-providers/${anotherId}/auth/attempts`, 'POST')).status,
        409,
      )
      assert.equal((await request(`/model-providers/${anotherId}/auth/logout`, 'POST')).status, 409)
      const busy = await (await request('/model-providers')).json()
      assert.equal(busy.instances.find(({ id }) => id === anotherId).status, 'busy')
      assert.equal(busy.instances.find(({ id }) => id === accountId).status, 'connected')
      const otherLogin = await (
        await request(`/model-providers/${accountId}/auth/attempts`, 'POST')
      ).json()
      const authorizing = await (await request('/model-providers')).json()
      assert.equal(authorizing.instances.find(({ id }) => id === accountId).status, 'authorizing')
      assert.equal((await (await request('/meta')).json()).configured, false)
      await request(`/model-auth-attempts/${otherLogin.id}/cancel`, 'POST')
      assert.equal((await (await request('/meta')).json()).configured, true)
    } finally {
      remote.responseGate?.resolve()
      remote.holdResponse = false
    }
    assert.equal((await probe).status, 204)
    remote.responseGate = null
    assert.deepEqual(await (await request('/conversations')).json(), conversationsBeforeProbe)
    assert.equal(
      (await (await request('/model-providers')).json()).defaultSelection.instanceId,
      accountId,
    )
    const anotherAuthorization = remote.requests.at(-1).authorization
    assert.notEqual(anotherAuthorization, remote.requests[0].authorization)
    assert.equal(
      (
        await request('/model', 'PUT', {
          instanceId: anotherId,
          modelId: remote.modelId,
        })
      ).status,
      200,
    )
    assert.equal(
      (await (await request('/meta')).json()).model.provider,
      `ChatGPT · test@example.com · ${anotherId.slice(0, 8)}`,
    )
    const originalBound = await send('默认账号切换后仍使用原账号')
    assert.equal(originalBound.run.status, 'completed')
    assert.equal(originalBound.run.target.instanceId, accountId)
    assert.equal(remote.requests.at(-1).authorization, remote.requests[0].authorization)
    assert.equal(remote.calls, 6)
    const anotherConversation = await (await request('/conversations', 'POST')).json()
    assert.equal(
      (await send('A separate account conversation', anotherConversation.id)).run.status,
      'completed',
    )
    assert.equal(remote.requests.at(-1).authorization, anotherAuthorization)
    assert.doesNotMatch(JSON.stringify(remote.requests.at(-1).body.input), /你好，请记住这个问候/)
    const selected = await request('/model', 'PUT', {
      instanceId: accountId,
      modelId: remote.modelId,
    })
    assert.equal(selected.status, 200)
    assert.deepEqual((await selected.json()).defaultSelection, {
      instanceId: accountId,
      modelId: remote.modelId,
    })
    assert.equal((await send('切回原账户继续')).run.status, 'completed')
    assert.equal(remote.requests.at(-1).authorization, remote.requests[0].authorization)
    assert.match(JSON.stringify(remote.requests.at(-1).body.input), /你好，请记住这个问候/)
    const state = await (await request('/model-providers')).json()
    assert.deepEqual(state.defaultSelection, {
      instanceId: accountId,
      modelId: remote.modelId,
    })
    assert.equal(state.instances.filter(({ kind }) => kind === 'chatgpt').length, 2)
    assert.deepEqual(
      await (await request(`/model-providers/${accountId}/auth/logout`, 'POST')).json(),
      { revoked: true },
    )
    assert.equal((await (await request('/meta')).json()).configured, false)
    const save = ProtectedFile.prototype.save
    const failModelSave = t.mock.method(ProtectedFile.prototype, 'save', function (value) {
      return value.version === 4
        ? Promise.reject(new Error('injected model save failure'))
        : save.call(this, value)
    })
    assert.equal((await request(`/model-providers/${accountId}`, 'DELETE')).status, 500)
    failModelSave.mock.restore()
    const afterModelFailure = await (await request('/model-providers')).json()
    assert.equal(afterModelFailure.defaultSelection.instanceId, accountId)
    assert.ok(afterModelFailure.instances.some(({ id }) => id === accountId))
    const failAccountSave = t.mock.method(ProtectedFile.prototype, 'save', function (value) {
      return value.version === 2 && !value.profiles.some(({ id }) => id === accountId)
        ? Promise.reject(new Error('injected account save failure'))
        : save.call(this, value)
    })
    assert.equal((await request(`/model-providers/${accountId}`, 'DELETE')).status, 500)
    failAccountSave.mock.restore()
    const afterAccountFailure = await (await request('/model-providers')).json()
    assert.equal(afterAccountFailure.defaultSelection, null)
    assert.ok(afterAccountFailure.instances.some(({ id }) => id === accountId))
    assert.equal((await request(`/model-providers/${accountId}`, 'DELETE')).status, 200)
    assert.equal(
      (await (await request('/model-providers')).json()).instances.some(
        ({ id }) => id === accountId,
      ),
      false,
    )
    assert.equal(
      (await (await request('/model-providers')).json()).instances.find(
        ({ id }) => id === anotherId,
      ).status,
      'connected',
    )
    // Different ChatGPT instances can run concurrently; logout cancels only its owner.
    const providers = await (await request('/model-providers', 'POST', { kind: 'chatgpt' })).json()
    const thirdId = providers.instances.at(-1).id
    const attempt = await (
      await request(`/model-providers/${thirdId}/auth/attempts`, 'POST')
    ).json()
    await remote.authorize(attempt, { subject: 'third-account' })
    for (let i = 0; i < 100; i++) {
      const status = await (await request(`/model-auth-attempts/${attempt.id}`)).json()
      if (status.status === 'completed') break
      await delay(20)
    }
    remote.holdResponse = true
    const start = async (instanceId) => {
      const conversation = await (
        await request('/conversations', 'POST', {
          selection: { instanceId, modelId: remote.modelId },
        })
      ).json()
      const run = await (
        await request(`/conversations/${conversation.id}/runs`, 'POST', {
          message: 'concurrent',
          requestId: crypto.randomUUID(),
          expectedTarget: { instanceId, modelId: remote.modelId },
        })
      ).json()
      for (let i = 0; i < 100; i++) {
        if (
          remote.requests.length &&
          remote.requests
            .at(-1)
            .body.input.some((item) => JSON.stringify(item).includes('concurrent')) &&
          remote.responseGate
        )
          break
        await delay(20)
      }
      return { conversation, run }
    }
    const held = await start(anotherId)
    const heldGate = remote.responseGate
    remote.responseGate = null
    const independent = await start(thirdId)
    assert.ok(remote.responseGate)
    assert.notEqual(remote.requests.at(-1).authorization, remote.requests.at(-2).authorization)
    await request(`/model-providers/${anotherId}/auth/logout`, 'POST')
    assert.equal(
      (await (await request(`/conversations/${held.conversation.id}`)).json()).run.status,
      'cancelled',
    )
    assert.equal(
      (await (await request(`/conversations/${independent.conversation.id}`)).json()).run.status,
      'running',
    )
    heldGate.resolve()
    remote.responseGate.resolve()
    await (await request(`/runs/${independent.run.id}/events`)).text()
    assert.equal(
      (await (await request(`/conversations/${independent.conversation.id}`)).json()).run.status,
      'completed',
    )
    assert.equal(remote.calls, 10)
    remote.holdResponse = false
    remote.responseGate = null
    const fourthId = await login('fourth-account')
    remote.responseError = 'subscription_sharing_invalid_user'
    const invalid = await request(`/model-providers/${thirdId}/test`, 'POST', {
      modelId: remote.modelId,
    })
    assert.equal(invalid.status, 503)
    assert.equal((await invalid.json()).error.code, 'auth_required')
    let accountsAfterProbe = (await (await request('/model-providers')).json()).instances
    assert.equal(accountsAfterProbe.find(({ id }) => id === thirdId).status, 'reauth_required')
    assert.equal(accountsAfterProbe.find(({ id }) => id === fourthId).status, 'connected')
    remote.responseError = 'chatpass_v2_scope_not_authorized'
    const missingPermission = await request(`/model-providers/${fourthId}/test`, 'POST', {
      modelId: remote.modelId,
    })
    assert.equal(missingPermission.status, 503)
    assert.equal((await missingPermission.json()).error.code, 'permission_missing')
    accountsAfterProbe = (await (await request('/model-providers')).json()).instances
    assert.equal(accountsAfterProbe.find(({ id }) => id === fourthId).planUsage, false)
  },
)
