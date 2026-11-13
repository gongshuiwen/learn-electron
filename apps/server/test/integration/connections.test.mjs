import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { startServer } from '../../src/server.ts'
import { createMockEngine } from '@learn-electron/agent-runtime'
import { ProtectedFile } from '../../src/shared/index.ts'
import { createServer } from 'node:http'
import { ChatGPTProvider } from '../../src/chatgpt/index.ts'
import { oauthFixture } from '../helpers/chatgpt.mjs'
import { modelProvider } from '../helpers/model-provider.mjs'
import { assertApiResponse } from '../helpers/contracts.mjs'

async function fixture(t, overrides = {}) {
  const remote = await modelProvider(t)
  const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-connections-'))
  const options = { token: 'connection-test-token', dataDir, ...overrides }
  let backend
  let starting = startServer(options).then((server) => {
    backend = server
  })
  t.after(async () => {
    await starting.catch(() => {})
    await backend?.close()
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()))
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
  })
  await starting
  t.signal.throwIfAborted()
  async function request(path, method = 'GET', body) {
    const response = await fetch(`${backend.url}/api/v1${path}`, {
      method,
      signal: t.signal,
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return assertApiResponse(response, path, method)
  }
  async function json(path, method = 'GET', body) {
    const response = await request(path, method, body)
    assert.ok(response.ok, await response.clone().text())
    return response.json()
  }
  async function save(patch = {}) {
    const state = await json('/model-providers', 'POST', {
      name: 'Gateway',
      protocol: 'openai-chat',
      baseUrl: `${remote.url}/v1`,
      authentication: 'api-key',
      apiKey: '!literal-application-key',
      headers: { 'X-Gateway-Key': '$literal-header' },
      models: [{ id: 'manual-unknown-model' }],
      ...patch,
    })
    return state.instances.filter((entry) => entry.kind === 'endpoint').at(-1)
  }
  async function send(id, message = 'hello', requestId = crypto.randomUUID()) {
    const expectedTarget = (await json(`/conversations/${id}`)).model.target
    const run = await json(`/conversations/${id}/runs`, 'POST', {
      message,
      requestId,
      ...(expectedTarget ? { expectedTarget } : {}),
    })
    await (await request(`/runs/${run.id}/events`)).text()
    return json(`/conversations/${id}`)
  }
  return {
    remote,
    dataDir,
    request,
    json,
    save,
    send,
    async beginLogin(id) {
      if (!id)
        id = (await json('/model-providers', 'POST', { kind: 'chatgpt' })).instances.at(-1).id
      return json(`/model-providers/${id}/auth/attempts`, 'POST')
    },
    close: () => backend.close(),
    async reopen() {
      t.signal.throwIfAborted()
      starting = (async () => {
        await backend.close()
        t.signal.throwIfAborted()
        backend = await startServer(options)
      })()
      await starting
      t.signal.throwIfAborted()
    },
  }
}

test(
  'an empty conversation can choose its own model without changing defaults or rebinding history',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    const first = await f.save()
    const second = await f.save({ apiKey: 'second-key', models: [{ id: 'second-model' }] })
    const direct = (entry) => ({
      instanceId: entry.id,
      modelId: entry.models[0].id,
    })
    await f.json('/model', 'PUT', direct(first))
    const conversation = await f.json('/conversations', 'POST')
    const before = await f.json(`/conversations/${conversation.id}`)
    const selected = await f.json(`/conversations/${conversation.id}/model`, 'PUT', direct(second))
    assert.equal(selected.conversation.id, conversation.id)
    assert.deepEqual(selected.conversation.selection, direct(second))
    assert.equal(selected.conversation.binding, undefined)
    assert.equal(selected.sequence, before.sequence + 1)
    assert.equal(selected.model.target.instanceId, second.id)
    assert.equal(selected.messages.length, 0)
    assert.deepEqual((await f.json('/model-providers')).defaultSelection, direct(first))
    assert.equal(f.remote.calls, 0)
    for (const expectedTarget of [direct(first), undefined]) {
      const stale = await f.request(`/conversations/${conversation.id}/runs`, 'POST', {
        message: 'stale client',
        requestId: 'stale-selection',
        ...(expectedTarget ? { expectedTarget } : {}),
      })
      assert.equal(stale.status, 409)
      assert.equal((await stale.json()).error.code, 'connection_changed')
    }
    assert.equal(f.remote.calls, 0)
    assert.equal((await f.json(`/conversations/${conversation.id}`)).messages.length, 0)
    const invalid = await f.request(`/conversations/${conversation.id}/model`, 'PUT', {
      ...direct(first),
      modelId: 'unknown',
    })
    assert.equal(invalid.status, 400)
    assert.deepEqual(await f.json(`/conversations/${conversation.id}`), selected)
    const generated = await f.send(conversation.id)
    assert.equal(f.remote.requests.at(-1).headers.authorization, 'Bearer second-key')
    const rejected = await f.request(
      `/conversations/${conversation.id}/model`,
      'PUT',
      direct(first),
    )
    assert.equal(rejected.status, 409)
    assert.equal((await rejected.json()).error.code, 'connection_changed')
    assert.deepEqual(await f.json(`/conversations/${conversation.id}`), generated)
    assert.equal((await f.json('/conversations')).length, 1)
  },
)

test(
  'direct choices preserve per-instance bindings, context and defaults across restart and removal',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    const first = await f.save({ name: 'Primary', vendor: 'same-vendor' })
    const second = await f.save({
      name: 'Secondary',
      vendor: 'same-vendor',
      apiKey: 'second-instance-key',
    })
    const ref = (instance) => ({ instanceId: instance.id, modelId: instance.models[0].id })
    await f.json('/model', 'PUT', ref(first))
    const old = await f.json('/conversations', 'POST')
    const initial = await f.send(old.id, 'bound to primary', 'direct-binding-request')
    assert.deepEqual(initial.conversation.binding, ref(first))
    await f.json('/model', 'PUT', ref(second))
    const newer = await f.json('/conversations', 'POST')
    assert.deepEqual(newer.selection, ref(second))
    const explicit = await f.json('/conversations', 'POST', { selection: ref(first) })
    assert.deepEqual((await f.send(explicit.id)).run.target, ref(first))
    await f.reopen()
    assert.deepEqual((await f.json('/model-providers')).defaultSelection, ref(second))
    const afterRestart = await f.json('/conversations', 'POST')
    assert.deepEqual(afterRestart.selection, ref(second))
    const replay = await f.json('/conversations/' + old.id + '/runs', 'POST', {
      message: 'bound to primary',
      requestId: 'direct-binding-request',
    })
    assert.equal(replay.id, initial.run.id)
    const onSecond = await f.send(newer.id)
    assert.equal(onSecond.run.status, 'completed', onSecond.run.error)
    assert.deepEqual(onSecond.run.target, ref(second))
    assert.equal(f.remote.requests.at(-1).headers.authorization, 'Bearer second-instance-key')
    const continued = await f.send(old.id, 'continue primary')
    assert.equal(continued.run.status, 'completed', continued.run.error)
    assert.deepEqual(continued.run.target, ref(first))
    assert.equal(f.remote.requests.at(-1).headers.authorization, 'Bearer !literal-application-key')
    assert.match(JSON.stringify(f.remote.requests.at(-1).body.messages), /bound to primary/)
    assert.match(JSON.stringify(f.remote.requests.at(-1).body.messages), /Provider reply/)
    const calls = f.remote.calls
    for (const [removed, bound, remainingDefault] of [
      [first, old, ref(second)],
      [second, newer, null],
    ]) {
      await f.json('/model-providers/' + removed.id, 'DELETE')
      assert.deepEqual((await f.json('/model-providers')).defaultSelection, remainingDefault)
      assert.equal((await f.json('/meta')).configured, remainingDefault !== null)
      assert.equal((await f.json('/conversations/' + bound.id)).model.configured, false)
      if (remainingDefault) {
        assert.equal((await f.json('/conversations/' + newer.id)).model.configured, true)
        await f.json('/model-providers/' + second.id + '/models')
      }
      assert.equal(
        (
          await f.request('/conversations/' + bound.id + '/runs', 'POST', {
            message: 'no fallback',
            requestId: 'removed-instance',
          })
        ).status,
        503,
      )
      assert.equal(
        f.remote.calls,
        calls,
        'Unavailable bindings and resource GETs must not contact another provider',
      )
    }
    const saved = await readFile(join(f.dataDir, 'models/connections.json'), 'utf8')
    assert.doesNotMatch(saved, /second-instance-key/)
    for (const path of [
      '/model-routes',
      '/providers',
      '/connections',
      '/auth/chatgpt/login',
      '/auth/chatgpt/select',
      '/auth/chatgpt/model',
    ])
      assert.equal((await f.request(path, 'POST', {})).status, 404)
  },
)

test(
  'removing the default endpoint leaves another endpoint available without selecting a fallback',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    const selected = await f.save()
    const retained = await f.save({ name: 'Retained', apiKey: 'retained-instance-key' })
    const ref = (entry) => ({ instanceId: entry.id, modelId: entry.models[0].id })
    await f.json('/model', 'PUT', ref(selected))
    const conversation = await f.json('/conversations', 'POST')
    await f.send(conversation.id)
    const explicit = await f.json('/conversations', 'POST', { selection: ref(retained) })
    const retainedFirst = await f.send(explicit.id, 'retain this bound history')
    assert.equal(retainedFirst.run.status, 'completed', retainedFirst.run.error)
    const calls = f.remote.calls

    await f.json(`/model-providers/${selected.id}`, 'DELETE')
    await f.reopen()
    const state = await f.json('/model-providers')
    assert.equal(state.defaultSelection, null)
    assert.deepEqual(
      state.instances.map(({ id }) => id),
      [retained.id],
    )
    assert.equal(state.instances[0].hasCredential, true)
    assert.equal((await f.json('/meta')).configured, false)
    assert.equal((await f.json(`/conversations/${conversation.id}`)).model.configured, false)
    assert.equal((await f.json(`/conversations/${explicit.id}`)).model.configured, true)
    const rejected = await f.request(`/conversations/${conversation.id}/runs`, 'POST', {
      message: 'do not use the retained endpoint',
      requestId: 'deleted-default-no-fallback',
      expectedTarget: ref(selected),
    })
    assert.equal(rejected.status, 503)
    assert.equal(f.remote.calls, calls)

    const result = await f.send(explicit.id, 'continue the retained binding')
    assert.equal(result.run.status, 'completed', result.run.error)
    assert.deepEqual(result.run.target, ref(retained))
    assert.equal(f.remote.requests.at(-1).headers.authorization, 'Bearer retained-instance-key')
    assert.match(
      JSON.stringify(f.remote.requests.at(-1).body.messages),
      /retain this bound history/,
    )
    assert.equal((await f.json('/model-providers')).defaultSelection, null)
  },
)

test(
  'unsupported model and account files are rejected without changing saved data',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    const entry = await f.save()
    const selection = { instanceId: entry.id, modelId: entry.models[0].id }
    await f.json('/model', 'PUT', selection)
    await f.close()
    const modelPath = join(f.dataDir, 'models/connections.json')
    const authPath = join(f.dataDir, 'chatgpt/connections.json')
    const model = await readFile(modelPath, 'utf8')
    const auth = await readFile(authPath, 'utf8')

    const unsupportedModel = JSON.stringify({ ...JSON.parse(model), version: 3 })
    await writeFile(modelPath, unsupportedModel)
    await assert.rejects(f.reopen(), /版本不受支持/)
    assert.equal(await readFile(modelPath, 'utf8'), unsupportedModel)
    assert.equal(await readFile(authPath, 'utf8'), auth)
    await writeFile(modelPath, model)
    const unsupportedAuth = JSON.stringify({ ...JSON.parse(auth), version: 1 })
    await writeFile(authPath, unsupportedAuth)
    await assert.rejects(f.reopen(), /版本不受支持/)
    assert.equal(await readFile(authPath, 'utf8'), unsupportedAuth)
    assert.equal(await readFile(modelPath, 'utf8'), model)

    await writeFile(authPath, auth)
    await f.reopen()
    assert.deepEqual((await f.json('/model-providers')).defaultSelection, selection)
    const conversation = await f.json('/conversations', 'POST')
    assert.equal((await f.send(conversation.id)).run.status, 'completed')
    assert.equal(f.remote.requests.at(-1).headers.authorization, 'Bearer !literal-application-key')
  },
)

test(
  'model discovery preserves other instances and their changes while the remote catalog is pending',
  { timeout: 25_000 },
  async (t) => {
    const f = await fixture(t)
    const first = await f.save()
    const second = await f.save()
    f.remote.holdCatalog = true
    const refresh = f.json(`/model-providers/${first.id}/models/refresh`, 'POST')
    let selection
    try {
      await Promise.race([
        f.remote.catalogStarted.promise,
        refresh.then(() => {
          throw new Error('Catalog discovery finished before the gate opened')
        }),
      ])
      selection = f.json('/model', 'PUT', { instanceId: second.id, modelId: second.models[0].id })
      const selected = await Promise.race([selection, delay(3000, null, { ref: false })])
      assert.ok(selected, 'another instance must not wait for model discovery')
      assert.equal((await f.request(`/model-providers/${first.id}`, 'PATCH', first)).status, 409)
      await f.json(`/model-providers/${second.id}`, 'PATCH', { ...second, name: 'Updated' })
    } finally {
      f.remote.catalogGate?.resolve()
      await Promise.allSettled([refresh, selection])
    }
    assert.ok((await refresh).some(({ id }) => id === 'discovered-model'))
    await f.reopen()
    const state = await f.json('/model-providers')
    assert.deepEqual(state.defaultSelection, {
      instanceId: second.id,
      modelId: second.models[0].id,
    })
    assert.equal(state.instances.find(({ id }) => id === second.id).name, 'Updated')
    assert.ok(
      state.instances
        .find(({ id }) => id === first.id)
        .models.some(({ id }) => id === 'discovered-model'),
    )
  },
)

test(
  'a demo conversation is never continued against a real provider',
  { timeout: 25_000 },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-demo-binding-'))
    const options = { dataDir, token: 'demo-binding-token' }
    let backend
    let starting = startServer({ ...options, engine: createMockEngine() }).then((server) => {
      backend = server
    })
    t.after(async () => {
      await starting.catch(() => {})
      await backend?.close()
      assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()))
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
    })
    await starting
    const request = (path, method = 'GET', body) =>
      fetch(backend.url + '/api/v1' + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + options.token,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    const conversation = await (await request('/conversations', 'POST', {})).json()
    const run = await (
      await request('/conversations/' + conversation.id + '/runs', 'POST', {
        message: 'demo message',
        requestId: 'demo-binding-request',
      })
    ).json()
    await (await request('/runs/' + run.id + '/events')).text()
    await backend.close()
    starting = startServer(options).then((server) => {
      backend = server
    })
    await starting
    const before = await (await request('/conversations/' + conversation.id)).json()
    assert.equal(before.model.configured, false)
    assert.equal(before.model.reason, 'context_unavailable')
    const response = await request('/conversations/' + conversation.id + '/runs', 'POST', {
      message: 'continue on another engine',
      requestId: 'demo-switch-request',
    })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'connection_changed')
    assert.deepEqual(await (await request('/conversations/' + conversation.id)).json(), before)
  },
)

test(
  'connection API ignores legacy credentials, redacts secrets and rolls back failed or busy configuration changes',
  { timeout: 35_000 },
  async (t) => {
    const legacy = {
      OPENAI_API_KEY: 'legacy-environment-key',
      PI_AUTH_MODE: '__retired_mode__',
      PI_PROVIDER: '__retired_provider__',
      PI_MODEL: '__retired_model__',
    }
    const original = Object.fromEntries(Object.keys(legacy).map((key) => [key, process.env[key]]))
    Object.assign(process.env, legacy)
    t.after(() => {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })

    const f = await fixture(t)
    assert.equal((await f.json('/meta')).configured, false)
    assert.equal((await f.json('/model-providers')).chatgpt.enabled, true)
    const first = await f.save()
    const second = await f.save({ apiKey: 'different-key' })
    assert.notEqual(first.id, second.id)
    assert.doesNotMatch(
      JSON.stringify(await f.json('/model-providers')),
      /literal-application-key|literal-header|different-key/,
    )
    assert.equal((await f.json('/meta')).configured, false)
    await f.json('/model', 'PUT', {
      instanceId: first.id,
      modelId: first.models[0].id,
    })
    const conversation = await f.json('/conversations', 'POST')
    const result = await f.send(conversation.id)
    assert.equal(result.run.status, 'completed', result.run.error)
    assert.equal(result.messages[1].content, 'Provider reply')
    assert.equal(f.remote.requests[0].headers.authorization, 'Bearer !literal-application-key')
    assert.equal(f.remote.requests[0].headers['x-gateway-key'], '$literal-header')
    assert.equal(
      (
        await f.request(`/model-providers/${first.id}`, 'PATCH', {
          ...first,
          baseUrl: `${f.remote.url}/other`,
        })
      ).status,
      409,
    )
    const save = t.mock.method(ProtectedFile.prototype, 'save', () =>
      Promise.reject(new Error('private-save-error')),
    )
    assert.equal(
      (await f.request(`/model-providers/${first.id}`, 'PATCH', { ...first, name: 'Unsaved' }))
        .status,
      500,
    )
    save.mock.restore()
    assert.equal((await f.json('/model-providers')).instances[0].name, 'Gateway')
    f.remote.hold = true
    const run = await f.json(`/conversations/${conversation.id}/runs`, 'POST', {
      message: 'hold',
      requestId: 'hold-request',
      expectedTarget: { instanceId: first.id, modelId: first.models[0].id },
    })
    for (let i = 0; i < 100 && !f.remote.gate; i++) await delay(10)
    assert.ok(f.remote.gate)
    assert.equal(
      (
        await f.request('/model', 'PUT', {
          instanceId: second.id,
          modelId: second.models[0].id,
        })
      ).status,
      200,
    )
    assert.equal(
      (await f.json(`/conversations/${conversation.id}`)).run.target.instanceId,
      first.id,
    )
    assert.equal((await f.request(`/model-providers/${first.id}`, 'PATCH', first)).status, 409)
    await f.json(`/runs/${run.id}/cancel`, 'POST')
    f.remote.gate.resolve()
    await (await f.request(`/runs/${run.id}/events`)).text()
    const cancelled = await f.json(`/conversations/${conversation.id}`)
    assert.equal(cancelled.run.status, 'cancelled')
    assert.deepEqual(cancelled.conversation.binding, {
      instanceId: first.id,
      modelId: first.models[0].id,
    })
    f.remote.hold = false
  },
)

test(
  'model generation and probes reject redirects without forwarding credentials for every protocol',
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t)
    let redirectStatus = 307
    const redirect = createServer((request, response) => {
      response.writeHead(redirectStatus, { Location: `${f.remote.url}${request.url}` })
      response.end()
    })
    await new Promise((done) => redirect.listen(0, '127.0.0.1', done))
    t.after(async () => {
      redirect.closeAllConnections()
      await new Promise((done) => redirect.close(done))
    })
    for (const protocol of [
      'openai-chat',
      'openai-responses',
      'anthropic-messages',
      'google-generative',
    ]) {
      const entry = await f.save({
        protocol,
        baseUrl: `http://127.0.0.1:${redirect.address().port}/v1`,
      })
      const probe = await f.request(`/model-providers/${entry.id}/test`, 'POST', {
        modelId: entry.models[0].id,
      })
      assert.equal(probe.status, 503, `${protocol} must reject a redirect`)
      assert.doesNotMatch(await probe.text(), /literal-application-key|literal-header/)
      await f.json('/model', 'PUT', {
        instanceId: entry.id,
        modelId: entry.models[0].id,
      })
      const conversation = await f.json('/conversations', 'POST')
      assert.equal((await f.send(conversation.id)).run.status, 'failed')
    }
    redirectStatus = 303
    const changesMethod = await f.save({
      baseUrl: `http://127.0.0.1:${redirect.address().port}/v1`,
    })
    assert.equal(
      (
        await f.request(`/model-providers/${changesMethod.id}/test`, 'POST', {
          modelId: changesMethod.models[0].id,
        })
      ).status,
      503,
    )
    assert.equal(f.remote.calls, 0, 'Redirects must not forward even a request changed to GET')
    assert.equal(
      f.remote.requests.length,
      0,
      'No redirected host may receive a request or credentials',
    )
  },
)

test(
  'API-key generation preserves the sanitized authentication, quota and model error codes',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    const entry = await f.save()
    await f.json('/model', 'PUT', {
      instanceId: entry.id,
      modelId: entry.models[0].id,
    })
    for (const [status, code] of [
      [401, 'auth_required'],
      [429, 'quota_exceeded'],
      [404, 'model_unavailable'],
    ]) {
      f.remote.status = status
      const conversation = await f.json('/conversations', 'POST')
      const snapshot = await f.send(conversation.id)
      assert.equal(snapshot.run.status, 'failed')
      assert.equal(snapshot.run.errorCode, code)
      assert.doesNotMatch(
        snapshot.run.error,
        /private-upstream-secret|literal-application-key|literal-header/,
      )
    }
  },
)

async function finishLogin(f, attempt, expected) {
  for (let i = 0; i < 200; i++) {
    const result = await f.json(`/model-auth-attempts/${attempt.id}`)
    if (result.status !== 'pending') {
      assert.equal(result.status, expected, result.error)
      return result
    }
    await delay(10)
  }
  assert.fail('ChatGPT login did not finish')
}

test(
  'ChatGPT authorization never changes the selected API connection; selection failure keeps the previous target',
  { timeout: 40_000 },
  async (t) => {
    const oauth = await oauthFixture(t)
    const f = await fixture(t, { chatgptOAuth: oauth.oauth })
    const entry = await f.save()
    await f.json('/model', 'PUT', {
      instanceId: entry.id,
      modelId: entry.models[0].id,
    })
    let attempt = await f.beginLogin()
    assert.equal(
      (await f.json('/model-providers')).defaultSelection?.instanceId,
      entry.id,
      'Starting login preserves the saved selection',
    )
    assert.equal(
      (await f.json('/meta')).configured,
      true,
      'Another instance remains ready while authorizing',
    )
    await f.request(`/model-auth-attempts/${attempt.id}/cancel`, 'POST')
    await finishLogin(f, attempt, 'cancelled')
    assert.equal((await f.json('/meta')).configured, true)
    assert.equal((await f.json('/model-providers')).defaultSelection?.instanceId, entry.id)

    oauth.tokenError = 'invalid_grant'
    attempt = await f.beginLogin()
    await oauth.authorize(attempt)
    await finishLogin(f, attempt, 'failed')
    assert.equal((await f.json('/model-providers')).defaultSelection?.instanceId, entry.id)
    assert.equal((await f.json('/meta')).configured, true)
    oauth.tokenError = null

    const exchange = Promise.withResolvers()
    const exchanging = Promise.withResolvers()
    oauth.delayExchange = () => {
      exchanging.resolve()
      return exchange.promise
    }
    attempt = await f.beginLogin()
    await oauth.authorize(attempt)
    await exchanging.promise
    await f.request(`/model-auth-attempts/${attempt.id}/cancel`, 'POST')
    exchange.resolve()
    oauth.delayExchange = null
    await f.reopen()
    assert.equal(
      (await f.json('/model-providers')).defaultSelection?.instanceId,
      entry.id,
      'A late exchange cannot activate its cancelled connection',
    )

    const begin = ChatGPTProvider.prototype.beginLogin
    const shortLogin = t.mock.method(ChatGPTProvider.prototype, 'beginLogin', function (profileId) {
      return begin.call(this, profileId, 25)
    })
    attempt = await f.beginLogin()
    await finishLogin(f, attempt, 'expired')
    shortLogin.mock.restore()
    await f.reopen()
    assert.equal((await f.json('/model-providers')).defaultSelection?.instanceId, entry.id)
    assert.equal((await f.json('/meta')).configured, true)

    attempt = await f.beginLogin()
    await oauth.authorize(attempt)
    const accountId = (await finishLogin(f, attempt, 'completed')).instanceId
    assert.equal((await f.json('/model-providers')).defaultSelection?.instanceId, entry.id)
    assert.equal((await f.json('/meta')).authMode, undefined)
    const save = ProtectedFile.prototype.save
    const rejectSelection = t.mock.method(ProtectedFile.prototype, 'save', function (state) {
      return state.defaultSelection?.instanceId === accountId
        ? Promise.reject(new Error('private-selection-error'))
        : save.call(this, state)
    })
    attempt = await f.beginLogin(accountId)
    await oauth.authorize(attempt)
    const signedIn = await finishLogin(f, attempt, 'completed')
    assert.equal(signedIn.error, undefined)
    const rejected = await f.request('/model', 'PUT', {
      instanceId: accountId,
      modelId: oauth.modelId,
    })
    assert.equal(rejected.status, 500)
    assert.doesNotMatch(await rejected.text(), /private-selection-error/)
    rejectSelection.mock.restore()
    assert.equal((await f.json('/model-providers')).defaultSelection?.instanceId, entry.id)
    assert.equal((await f.json('/meta')).configured, true)
    await f.json('/model', 'PUT', { instanceId: accountId, modelId: oauth.modelId })
    assert.equal(
      (await f.json('/meta')).authMode,
      'chatgpt',
      'Durable OAuth credentials remain usable after selection persistence fails',
    )
  },
)

test(
  'logging out of an inactive ChatGPT account leaves API-key generation running',
  { timeout: 30_000 },
  async (t) => {
    const oauth = await oauthFixture(t)
    const f = await fixture(t, { chatgptOAuth: oauth.oauth })
    const login = await f.beginLogin()
    await oauth.authorize(login)
    const accountId = (await finishLogin(f, login, 'completed')).instanceId
    const entry = await f.save()
    await f.json('/model', 'PUT', {
      instanceId: entry.id,
      modelId: entry.models[0].id,
    })
    f.remote.hold = true
    const conversation = await f.json('/conversations', 'POST')
    const run = await f.json(`/conversations/${conversation.id}/runs`, 'POST', {
      message: 'Keep generating',
      requestId: 'inactive-logout',
      expectedTarget: { instanceId: entry.id, modelId: entry.models[0].id },
    })
    for (let i = 0; i < 200 && !f.remote.gate; i++) await delay(10)
    assert.ok(f.remote.gate)
    const logout = await f.json(`/model-providers/${accountId}/auth/logout`, 'POST')
    assert.equal(logout.revoked, true)
    assert.equal((await f.json(`/conversations/${conversation.id}`)).run.status, 'running')
    f.remote.gate.resolve()
    await (await f.request(`/runs/${run.id}/events`)).text()
    assert.equal((await f.json(`/conversations/${conversation.id}`)).run.status, 'completed')
    assert.equal((await f.json('/model-providers')).defaultSelection?.instanceId, entry.id)
    const originalFetch = globalThis.fetch
    t.mock.method(globalThis, 'fetch', (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      )
      return url.origin === 'https://api.openai.com'
        ? originalFetch(`${oauth.issuer}${url.pathname}${url.search}`, init)
        : originalFetch(input, init)
    })
    const reconnect = await f.beginLogin(accountId)
    await oauth.authorize(reconnect)
    await finishLogin(f, reconnect, 'completed')
    assert.equal((await f.json('/model-providers')).defaultSelection?.instanceId, entry.id)
    await f.json('/model', 'PUT', { instanceId: accountId, modelId: oauth.modelId })
    oauth.holdResponse = true
    const chatGPTConversation = await f.json('/conversations', 'POST')
    const chatGPTRun = await f.json(`/conversations/${chatGPTConversation.id}/runs`, 'POST', {
      message: 'Stop this ChatGPT reply',
      requestId: 'active-chatgpt-logout',
      expectedTarget: { instanceId: accountId, modelId: oauth.modelId },
    })
    for (let i = 0; i < 200 && !oauth.responseGate; i++) await delay(10)
    assert.ok(oauth.responseGate)
    await f.json(`/model-providers/${accountId}/auth/logout`, 'POST')
    oauth.responseGate.resolve()
    await (await f.request(`/runs/${chatGPTRun.id}/events`)).text()
    assert.equal((await f.json(`/conversations/${chatGPTConversation.id}`)).run.status, 'cancelled')
  },
)

for (const protocol of [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'google-generative',
]) {
  test(
    `${protocol}: custom model IDs, literal authentication, discovery and an independent probe use the real Pi adapter`,
    { timeout: 25_000 },
    async (t) => {
      const f = await fixture(t)
      const entry = await f.save({
        protocol,
        baseUrl: protocol === 'anthropic-messages' ? f.remote.url : `${f.remote.url}/v1`,
        compatibility:
          protocol === 'openai-chat'
            ? {
                supportsDeveloperRole: false,
                supportsUsageInStreaming: false,
                supportsStore: false,
                maxTokensField: 'max_tokens',
              }
            : {},
      })
      const probe = await f.request(`/model-providers/${entry.id}/test`, 'POST', {
        modelId: entry.models[0].id,
      })
      assert.equal(probe.status, 204, await probe.text())
      assert.equal((await f.json('/conversations')).length, 0)
      const headers = f.remote.requests[0].headers
      assert.equal(headers['x-gateway-key'], '$literal-header')
      assert.equal(
        headers[
          protocol === 'anthropic-messages'
            ? 'x-api-key'
            : protocol === 'google-generative'
              ? 'x-goog-api-key'
              : 'authorization'
        ],
        protocol.startsWith('openai-')
          ? 'Bearer !literal-application-key'
          : '!literal-application-key',
      )
      await f.json('/model', 'PUT', {
        instanceId: entry.id,
        modelId: entry.models[0].id,
      })
      const conversation = await f.json('/conversations', 'POST')
      const result = await f.send(conversation.id)
      assert.equal(result.run.status, 'completed', result.run.error)
      assert.equal(result.messages[1].content, 'Provider reply')
      if (protocol === 'openai-chat') {
        const body = f.remote.requests.at(-1).body
        assert.equal(body.messages[0].role, 'system')
        assert.ok(body.max_tokens > 0)
        for (const key of ['max_completion_tokens', 'stream_options', 'store'])
          assert.equal(key in body, false)
      }
      const models = await f.json(`/model-providers/${entry.id}/models/refresh`, 'POST')
      assert.deepEqual(
        models.map(({ id }) => id),
        ['manual-unknown-model', 'discovered-model'],
      )
      assert.equal((await f.json('/meta')).model.id, 'manual-unknown-model')
      if (protocol === 'anthropic-messages') {
        const versioned = await f.save({ protocol, baseUrl: `${f.remote.url}/v1` })
        assert.equal(
          (
            await f.request(`/model-providers/${versioned.id}/test`, 'POST', {
              modelId: versioned.models[0].id,
            })
          ).status,
          204,
        )
        assert.equal(f.remote.requests.at(-1).path, '/v1/messages')
      }
    },
  )
}

test(
  'keyless local endpoints receive no placeholder authorization and credential clearing does not use environment keys',
  { timeout: 25_000 },
  async (t) => {
    const f = await fixture(t)
    let entry
    for (const protocol of ['openai-chat', 'openai-responses']) {
      entry = await f.save({ protocol, authentication: 'none', headers: {} })
      await f.json('/model', 'PUT', {
        instanceId: entry.id,
        modelId: entry.models[0].id,
      })
      const conversation = await f.json('/conversations', 'POST')
      assert.equal((await f.send(conversation.id)).run.status, 'completed')
      assert.equal(f.remote.requests.at(-1).headers.authorization, undefined)
    }
    const keyed = await f.save({ apiKey: 'key-to-remove' })
    await f.json('/model', 'PUT', {
      instanceId: keyed.id,
      modelId: keyed.models[0].id,
    })
    assert.equal((await f.json('/meta')).configured, true)
    const cleared = await f.json(`/model-providers/${keyed.id}`, 'PATCH', {
      ...keyed,
      apiKey: null,
    })
    assert.equal(cleared.instances.find(({ id }) => id === keyed.id).hasCredential, false)
    assert.equal((await f.json('/meta')).configured, false)
    const headerOwned = await f.save({
      authentication: 'none',
      headers: { Authorization: 'Bearer header-owned' },
    })
    assert.equal(
      (
        await f.request(`/model-providers/${headerOwned.id}/test`, 'POST', {
          modelId: headerOwned.models[0].id,
        })
      ).status,
      204,
    )
    assert.equal(f.remote.requests.at(-1).headers.authorization, 'Bearer header-owned')
  },
)

test(
  'connection probes release the change guard after invalid targets, sanitize errors and cancel on shutdown',
  { timeout: 25_000 },
  async (t) => {
    const f = await fixture(t)
    const entry = await f.save()
    assert.equal((await f.request(`/model-providers/${entry.id}/test`, 'POST', [])).status, 400)
    assert.equal((await f.request('/model-providers/missing/models')).status, 404)
    const invalidTarget = await f.request(`/model-providers/${entry.id}/test`, 'POST', {
      modelId: 'not-configured-model',
    })
    assert.equal(invalidTarget.status, 400)
    assert.equal((await invalidTarget.json()).error.code, 'model_unavailable')
    assert.equal(f.remote.requests.length, 0)
    f.remote.status = 401
    const failed = await f.request(`/model-providers/${entry.id}/test`, 'POST', {
      modelId: entry.models[0].id,
    })
    assert.equal(failed.status, 503)
    const failure = await failed.text()
    assert.match(failure, /auth_required/)
    assert.doesNotMatch(failure, /private-upstream-secret|literal-application-key|literal-header/)
    f.remote.status = 200
    f.remote.hold = true
    const pending = f
      .request(`/model-providers/${entry.id}/test`, 'POST', { modelId: entry.models[0].id })
      .catch(() => null)
    for (let i = 0; i < 100 && !f.remote.gate; i++) await delay(10)
    assert.ok(f.remote.gate)
    await f.reopen()
    await pending
    assert.equal((await f.json('/meta')).configured, false)
    assert.equal((await f.json('/model-providers')).instances[0].hasCredential, true)
    assert.deepEqual(await f.json('/conversations'), [])
  },
)
