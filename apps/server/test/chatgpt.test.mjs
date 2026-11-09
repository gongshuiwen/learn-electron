import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ChatGPTConnectionService } from '../src/chatgpt/connection-service.ts'
import { ConnectionStorage } from '../src/chatgpt/storage.ts'
import { getOpenAIModels } from '@learn-electron/agent-runtime'
import { oauthFixture } from './helpers/chatgpt.mjs'

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
  let service = await ChatGPTConnectionService.create(options)
  t.after(async () => {
    await service.close()
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()))
    await rm(dataDir, { recursive: true, force: true })
  })
  return {
    remote,
    dataDir,
    get service() {
      return service
    },
    busy(value) {
      busy = value
    },
    async reopen() {
      await service.close()
      service = await ChatGPTConnectionService.create(options)
      return service
    },
  }
}

async function finish(service, id, expected = 'completed') {
  for (let i = 0; i < 200; i++) {
    const view = service.login(id)
    if (view.status !== 'pending') {
      assert.equal(view.status, expected, view.error)
      return view
    }
    await delay(10)
  }
  assert.fail('Login did not finish')
}

async function login(f) {
  const attempt = await f.service.beginLogin()
  assert.deepEqual(f.service.status().pendingLogin, attempt)
  assert.equal((await f.remote.authorize(attempt)).status, 200)
  await finish(f.service, attempt.id)
  return attempt
}

test('OIDC validates signature, issuer, audience, expiration and nonce', async (t) => {
  const remote = await oauthFixture(t)
  const valid = await remote.sign({ nonce: 'nonce' })
  assert.equal((await remote.oauth.identity(valid, 'test-client', 'nonce')).subject, 'user')
  for (const [token, client, nonce] of [
    [valid, 'wrong-client', 'nonce'],
    [valid, 'test-client', 'wrong-nonce'],
    [
      await remote.sign({ nonce: 'nonce' }, { issuer: 'https://wrong.example' }),
      'test-client',
      'nonce',
    ],
    [
      await remote.sign({ nonce: 'nonce' }, { expiration: Math.floor(Date.now() / 1000) - 60 }),
      'test-client',
      'nonce',
    ],
    [`${valid.slice(0, -8)}tampered`, 'test-client', 'nonce'],
  ])
    await assert.rejects(remote.oauth.identity(token, client, nonce))
})

test('login persists a separate registration, exposes no secrets and resumes without network', async (t) => {
  const f = await fixture(t)
  const attempt = await login(f)
  const params = new URL(attempt.authorizationUrl).searchParams
  assert.equal(params.get('client_id'), 'dynamic_agent_client')
  assert.equal(params.get('agent_name_hint'), 'Pi Chat')
  assert.equal(params.get('code_challenge_method'), 'S256')
  const state = f.service.status()
  assert.equal(state.profiles[0].planUsage, true)
  assert.equal(state.profiles[0].label, 'test@example.com')
  assert.equal(f.service.snapshot().modelId, f.remote.modelId)
  assert.equal((await f.service.models()).length, 1)
  assert.doesNotMatch(JSON.stringify(state), /plan-access|plan-refresh|idToken|clientId/)
  const stored = JSON.parse(await readFile(join(f.dataDir, 'chatgpt/connections.json'), 'utf8'))
  assert.ok(stored.profiles[0].tokens.refreshToken)
  await f.reopen()
  assert.deepEqual(f.service.status(), state)
  const repeat = await f.service.beginLogin(state.activeId)
  const repeatedParams = new URL(repeat.authorizationUrl).searchParams
  assert.equal(repeatedParams.get('client_id'), stored.profiles[0].clientId)
  assert.equal(repeatedParams.get('ext_agent_host_id'), params.get('ext_agent_host_id'))
  assert.equal(repeatedParams.has('agent_name_hint'), false)
  assert.equal(repeatedParams.has('id_token_hint'), false)
  f.service.cancelLogin(repeat.id)
})

test('invalid state, cancellation, timeout and a late exchange never activate a connection', async (t) => {
  const f = await fixture(t)
  const attempt = await f.service.beginLogin()
  assert.equal((await f.remote.authorize(attempt, { state: 'forged' })).status, 400)
  assert.equal(f.service.login(attempt.id).status, 'pending')
  let release
  let started
  const began = new Promise((resolve) => {
    started = resolve
  })
  f.remote.delayExchange = () => {
    started()
    return new Promise((resolve) => {
      release = resolve
    })
  }
  await f.remote.authorize(attempt)
  await began
  f.service.cancelLogin(attempt.id)
  release()
  await delay(100)
  assert.equal(f.service.status().activeId, null)
  assert.equal(f.service.login(attempt.id).status, 'cancelled')
  assert.equal(f.remote.revoked.length, 1)
  const expired = await f.service.beginLogin(undefined, 20)
  await delay(40)
  assert.equal(f.service.login(expired.id).status, 'expired')
})

test('declined plan permission retains identity and reconnect reuses registration', async (t) => {
  const f = await fixture(t)
  f.remote.scopes = 'openid profile email'
  await login(f)
  assert.equal(f.service.status().profiles[0].status, 'connected')
  assert.equal(f.service.status().profiles[0].planUsage, false)
  assert.equal(f.service.snapshot(), undefined)
  const repeat = await f.service.beginLogin(f.service.status().activeId)
  assert.equal(new URL(repeat.authorizationUrl).searchParams.get('prompt'), 'consent')
  f.service.cancelLogin(repeat.id)
})

test('issued client IDs survive failed exchange; account mismatch cannot replace an existing connection', async (t) => {
  const f = await fixture(t)
  f.remote.tokenError = 'invalid_grant'
  const attempt = await f.service.beginLogin()
  await f.remote.authorize(attempt)
  await finish(f.service, attempt.id, 'failed')
  assert.equal(f.service.status().profiles.length, 1)
  const id = f.service.status().profiles[0].id
  f.remote.tokenError = { code: 'unsupported_country_region_territory' }
  f.remote.tokenErrorStatus = 403
  const denied = await f.service.beginLogin(id)
  await f.remote.authorize(denied)
  const failure = await finish(f.service, denied.id, 'failed')
  assert.match(failure.error, /unsupported_country_region_territory/)
  assert.equal(f.service.snapshot(), undefined)
  assert.equal(f.service.status().profiles.length, 1)
  assert.equal(f.service.status().profiles[0].status, 'signed_out')
  f.remote.tokenError = null
  const repeat = await f.service.beginLogin(id)
  await f.remote.authorize(repeat)
  await finish(f.service, repeat.id)
  const old = f.service.status()
  const mismatch = await f.service.beginLogin(id)
  await f.remote.authorize(mismatch, { subject: 'other-user' })
  await finish(f.service, mismatch.id, 'failed')
  assert.deepEqual(f.service.status(), old)
})

test('refresh is serialized and durably saved even when its requesting run is cancelled', async (t) => {
  const f = await fixture(t)
  f.remote.expiresIn = 120
  await login(f)
  const storage = new ConnectionStorage(f.dataDir)
  const saved = await storage.load()
  saved.profiles[0].tokens.expiresAt = Date.now() - 1
  await storage.save(saved)
  await f.reopen()
  let release
  let started
  const began = new Promise((resolve) => {
    started = resolve
  })
  f.remote.delayRefresh = () => {
    started()
    return new Promise((resolve) => {
      release = resolve
    })
  }
  const id = f.service.status().activeId
  const controller = new AbortController()
  const first = f.service.token(id, controller.signal)
  const cancelled = assert.rejects(first, { name: 'AbortError' })
  await began
  const second = f.service.token(id, new AbortController().signal)
  controller.abort()
  await cancelled
  release()
  const token = await second
  assert.equal(f.remote.refreshes, 1)
  const latest = await storage.load()
  assert.equal(latest.profiles[0].tokens.accessToken, token)
  assert.notEqual(latest.profiles[0].tokens.refreshToken, saved.profiles[0].tokens.refreshToken)
})

test('logout waits for rotated credentials, revokes the latest token and blocks account changes during runs', async (t) => {
  const f = await fixture(t)
  await login(f)
  f.busy(true)
  await assert.rejects(f.service.select(f.service.status().activeId), { code: 'connection_busy' })
  let stopped = false
  const result = await f.service.logout(async () => {
    stopped = true
    f.busy(false)
  })
  assert.equal(stopped, true)
  assert.equal(result.revoked, true)
  assert.equal(f.service.snapshot(), undefined)
  assert.equal(f.service.status().profiles[0].status, 'signed_out')
  assert.equal(f.remote.revoked.length, 1)
  assert.ok((await new ConnectionStorage(f.dataDir).load()).profiles[0].clientId)
})

test('refresh preserves credentials on temporary errors and requires reauthorization only for terminal errors', async (t) => {
  const f = await fixture(t)
  await login(f)
  const storage = new ConnectionStorage(f.dataDir)
  const saved = await storage.load()
  saved.profiles[0].tokens.expiresAt = Date.now() - 1
  await storage.save(saved)
  await f.reopen()
  const id = f.service.status().activeId
  f.remote.tokenError = 'temporarily_unavailable'
  await assert.rejects(f.service.token(id, new AbortController().signal), {
    code: 'provider_failed',
  })
  assert.equal(f.service.status().profiles[0].status, 'connected')
  assert.equal(
    (await storage.load()).profiles[0].tokens.refreshToken,
    saved.profiles[0].tokens.refreshToken,
  )
  f.remote.tokenError = 'invalid_grant'
  await assert.rejects(f.service.token(id, new AbortController().signal), { code: 'auth_required' })
  assert.equal(f.service.status().profiles[0].status, 'reauth_required')
  assert.equal((await storage.load()).profiles[0].tokens, undefined)
})

test('a failed rotation save retries persistence rather than refreshing an obsolete token', async (t) => {
  const f = await fixture(t)
  await login(f)
  const storage = new ConnectionStorage(f.dataDir)
  const saved = await storage.load()
  saved.profiles[0].tokens.expiresAt = Date.now() - 1
  await storage.save(saved)
  await f.reopen()
  const save = ConnectionStorage.prototype.save
  let fail = true
  t.mock.method(ConnectionStorage.prototype, 'save', async function (next) {
    if (fail && next.profiles[0].tokens?.refreshToken !== saved.profiles[0].tokens.refreshToken) {
      fail = false
      throw new Error('simulated disk failure')
    }
    return save.call(this, next)
  })
  const id = f.service.status().activeId
  await assert.rejects(f.service.token(id, new AbortController().signal), {
    code: 'provider_failed',
  })
  assert.equal(f.remote.refreshes, 1)
  const token = await f.service.token(id, new AbortController().signal)
  assert.equal(f.remote.refreshes, 1)
  assert.equal((await storage.load()).profiles[0].tokens.accessToken, token)
})

test('logout waits for an in-flight refresh and revokes its latest replacement even after cancellation', async (t) => {
  const f = await fixture(t)
  await login(f)
  const storage = new ConnectionStorage(f.dataDir)
  const saved = await storage.load()
  saved.profiles[0].tokens.expiresAt = Date.now() - 1
  await storage.save(saved)
  await f.reopen()
  let release
  let started
  const began = new Promise((resolve) => {
    started = resolve
  })
  f.remote.delayRefresh = () => {
    started()
    return new Promise((resolve) => {
      release = resolve
    })
  }
  const controller = new AbortController()
  const cancelled = assert.rejects(
    f.service.token(f.service.status().activeId, controller.signal),
    { name: 'AbortError' },
  )
  await began
  const logout = f.service.logout(async () => controller.abort())
  await cancelled
  release()
  assert.deepEqual(await logout, { revoked: true })
  assert.equal(f.remote.revoked.at(-1), f.remote.latestRefreshToken)
  assert.equal((await storage.load()).profiles[0].tokens, undefined)
  assert.equal(f.service.snapshot(), undefined)
})

test('failed remote revocation clears local tokens and reports the incomplete remote result', async (t) => {
  const f = await fixture(t)
  await login(f)
  f.remote.revocationFails = true
  assert.deepEqual(await f.service.logout(async () => {}), { revoked: false })
  assert.equal((await new ConnectionStorage(f.dataDir).load()).profiles[0].tokens, undefined)
})
