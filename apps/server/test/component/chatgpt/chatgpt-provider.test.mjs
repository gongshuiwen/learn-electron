import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { getOpenAIModels } from '@learn-electron/agent-runtime'
import { ModelError } from '@learn-electron/model-connections'
import { ChatGPTProvider } from '../../../src/chatgpt/index.ts'
import { ConnectionStorage } from '../../../src/chatgpt/storage.ts'
import { ApplicationError, ProtectedFile } from '../../../src/shared/index.ts'
import { finishLogin, oauthFixture } from '../../helpers/chatgpt.mjs'

async function fixture(t) {
  const remote = await oauthFixture(t)
  const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-chatgpt-'))
  let busy = false
  const options = {
    dataDir,
    models: await getOpenAIModels(),
    oauth: remote.oauth,
    isBusy: () => busy,
  }
  let service = await ChatGPTProvider.create(options)
  t.after(async () => {
    await service.close()
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()))
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
  })
  return {
    remote,
    dataDir,
    get id() {
      return service.status().profiles.at(-1)?.id
    },
    get service() {
      return service
    },
    busy(value) {
      busy = value
    },
    async reopen() {
      await service.close()
      service = await ChatGPTProvider.create(options)
    },
  }
}

async function login(f) {
  const attempt = await f.service.beginLogin(await f.service.createProfile())
  await f.remote.authorize(attempt)
  await finishLogin(f.service, attempt.id)
  return attempt
}

test('provider stores credentials and filters the authorized catalog for the runtime, including earlier v2 files', async (t) => {
  const f = await fixture(t)
  const attempt = await login(f)
  assert.equal(new URL(attempt.authorizationUrl).searchParams.get('agent_name_hint'), 'Pi Chat')
  const state = f.service.status()
  assert.equal(state.profiles[0].planUsage, true)
  assert.equal(state.profiles[0].name, `test@example.com · ${f.id.slice(0, 8)}`)
  assert.doesNotMatch(JSON.stringify(state), /plan-access|plan-refresh|idToken|clientId/)
  assert.equal(f.service.model(f.id, f.remote.modelId).id, f.remote.modelId)
  assert.deepEqual(
    (await f.service.models(f.id)).map(({ id }) => id),
    [f.remote.modelId],
  )
  assert.throws(
    () => f.service.model(f.id, 'unknown-to-pi'),
    (error) => error instanceof ApplicationError && error.code === 'model_unavailable',
  )
  const stored = JSON.parse(await readFile(join(f.dataDir, 'chatgpt/connections.json'), 'utf8'))
  assert.ok(stored.profiles[0].tokens.refreshToken)
  assert.ok(stored.profiles[0].models.some((model) => model.id === 'unknown-to-pi'))
  // Earlier v2 files cached only models supported by the runtime.
  stored.profiles[0].models = stored.profiles[0].models.filter(
    (model) => model.id === f.remote.modelId,
  )
  await new ConnectionStorage(f.dataDir).save(stored)
  t.mock.method(f.remote.oauth, 'models', () => assert.fail('Cached models must remain offline'))
  t.mock.method(f.remote.oauth, 'token', () => assert.fail('Reopening must not exchange tokens'))
  await f.reopen()
  assert.deepEqual(f.service.status(), state)
  assert.equal(f.service.model(f.id, f.remote.modelId).id, f.remote.modelId)
  assert.deepEqual(
    (await f.service.models(f.id)).map(({ id }) => id),
    [f.remote.modelId],
  )
})

test('provider guards active generations, allows logout to stop them and translates authorization errors', async (t) => {
  const f = await fixture(t)
  f.remote.scopes = 'openid profile email'
  await login(f)
  assert.throws(
    () => f.service.model(f.id, f.remote.modelId),
    (error) => error instanceof ModelError && error.code === 'permission_missing',
  )
  await assert.rejects(
    f.service.token(f.id, t.signal),
    (error) => error instanceof ModelError && error.code === 'permission_missing',
  )
  f.busy(true)
  await assert.rejects(
    f.service.beginLogin(f.id),
    (error) => error instanceof ApplicationError && error.code === 'connection_busy',
  )
  let stopped = false
  const result = await f.service.logout(f.id, async () => {
    stopped = true
    f.busy(false)
  })
  assert.equal(stopped, true)
  assert.equal(result.revoked, true)
  assert.throws(
    () => f.service.model(f.id, f.remote.modelId),
    (error) => error instanceof ModelError && error.code === 'auth_required',
  )
  await assert.rejects(
    f.service.token(f.id, t.signal),
    (error) => error instanceof ModelError && error.code === 'auth_required',
  )
  assert.equal(f.service.status().profiles[0].status, 'signed_out')
  assert.equal(f.remote.revoked.length, 1)
  assert.ok((await new ConnectionStorage(f.dataDir).load()).profiles[0].clientId)
  await assert.rejects(
    f.service.beginLogin('missing-account'),
    (error) => error instanceof ApplicationError && error.code === 'connection_not_found',
  )
})

test(
  'concurrent account refreshes survive caller cancellation and credential-file reload',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await login(f)
    const firstId = f.id
    f.remote.subject = 'second-user'
    await login(f)
    const secondId = f.id
    const storage = new ConnectionStorage(f.dataDir)
    const before = await storage.load()
    for (const profile of before.profiles) profile.tokens.expiresAt = Date.now() - 1
    await storage.save(before)
    await f.reopen()

    const bothStarted = Promise.withResolvers()
    const release = Promise.withResolvers()
    t.signal.addEventListener('abort', () => release.resolve(), { once: true })
    f.remote.delayRefresh = () => {
      if (f.remote.refreshes === 2) bothStarted.resolve()
      return release.promise
    }
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(5000)])
    const controller = new AbortController()
    const first = f.service.token(firstId, AbortSignal.any([signal, controller.signal]))
    const cancelled = assert.rejects(first, { name: 'AbortError' })
    const second = f.service.token(secondId, signal)
    let firstRetry
    const refreshing = Promise.all([cancelled, second])
    let tokens
    try {
      await Promise.race([
        bothStarted.promise,
        refreshing.then(() => assert.fail('Both refreshes must start before the gate opens')),
      ])
      controller.abort()
      await cancelled
      firstRetry = f.service.token(firstId, signal)
      release.resolve()
      tokens = await Promise.all([firstRetry, second])
    } finally {
      release.resolve()
      controller.abort()
      await Promise.allSettled([refreshing, firstRetry])
    }

    const durable = await new ConnectionStorage(f.dataDir).load()
    assert.equal(durable.profiles.length, 2)
    for (const [index, id] of [firstId, secondId].entries()) {
      const stored = durable.profiles.find((profile) => profile.id === id)
      assert.equal(stored.tokens.accessToken, tokens[index])
      assert.notEqual(
        stored.tokens.refreshToken,
        before.profiles.find((profile) => profile.id === id).tokens.refreshToken,
      )
    }
    assert.notEqual(tokens[0], tokens[1])
    await f.reopen()
    assert.deepEqual(
      await Promise.all([f.service.token(firstId, t.signal), f.service.token(secondId, t.signal)]),
      tokens,
    )
    assert.equal(f.remote.refreshes, 2)
  },
)

test(
  'temporary refresh errors retain the credential file and terminal errors persist reauthorization',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await login(f)
    const id = f.id
    const storage = new ConnectionStorage(f.dataDir)
    const state = await storage.load()
    state.profiles[0].tokens.expiresAt = Date.now() - 1
    await storage.save(state)
    await f.reopen()
    const path = join(f.dataDir, 'chatgpt/connections.json')
    const before = await readFile(path, 'utf8')

    f.remote.tokenError = 'temporarily_unavailable'
    await assert.rejects(
      f.service.token(id, t.signal),
      (error) => error instanceof ModelError && error.code === 'provider_failed',
    )
    assert.equal(await readFile(path, 'utf8'), before)
    await f.reopen()
    assert.equal(f.service.status().profiles[0].status, 'connected')

    f.remote.tokenError = 'invalid_grant'
    await assert.rejects(
      f.service.token(id, t.signal),
      (error) => error instanceof ModelError && error.code === 'auth_required',
    )
    const durable = await new ConnectionStorage(f.dataDir).load()
    assert.equal(durable.profiles[0].tokens, undefined)
    assert.equal(durable.profiles[0].reauth, true)
    assert.equal(durable.profiles[0].clientId, state.profiles[0].clientId)
    await f.reopen()
    assert.equal(f.service.status().profiles[0].status, 'reauth_required')
    assert.throws(
      () => f.service.model(id, f.remote.modelId),
      (error) => error instanceof ModelError && error.code === 'auth_required',
    )
  },
)

test(
  'a failed credential-file rotation keeps the old file and retries the replacement before reopening',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await login(f)
    const id = f.id
    const storage = new ConnectionStorage(f.dataDir)
    const state = await storage.load()
    const oldRefreshToken = state.profiles[0].tokens.refreshToken
    state.profiles[0].tokens.expiresAt = Date.now() - 1
    await storage.save(state)
    await f.reopen()
    const path = join(f.dataDir, 'chatgpt/connections.json')
    const before = await readFile(path, 'utf8')
    const save = ProtectedFile.prototype.save
    let fail = true
    t.mock.method(ProtectedFile.prototype, 'save', async function (next) {
      const replacement = next.profiles?.find((profile) => profile.id === id)?.tokens?.refreshToken
      if (fail && replacement && replacement !== oldRefreshToken) {
        fail = false
        throw new Error('injected credential write failure')
      }
      return save.call(this, next)
    })

    await assert.rejects(
      f.service.token(id, t.signal),
      (error) => error instanceof ModelError && error.code === 'provider_failed',
    )
    assert.equal(fail, false, 'the replacement save must have reached the file adapter')
    assert.equal(f.remote.refreshes, 1)
    assert.equal(await readFile(path, 'utf8'), before)

    const token = await f.service.token(id, t.signal)
    const durable = await new ConnectionStorage(f.dataDir).load()
    assert.equal(durable.profiles[0].tokens.accessToken, token)
    assert.equal(durable.profiles[0].tokens.refreshToken, f.remote.latestRefreshToken)
    assert.notEqual(durable.profiles[0].tokens.refreshToken, oldRefreshToken)
    await f.reopen()
    assert.equal(await f.service.token(id, t.signal), token)
    assert.equal(f.remote.refreshes, 1, 'retrying the save must not refresh the obsolete token')
  },
)
