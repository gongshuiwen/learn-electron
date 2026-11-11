import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Server } from 'node:http'
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
  const attempt = await f.service.beginLogin(await f.service.createProfile())
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
  assert.equal(state.profiles[0].name, `test@example.com · ${f.id.slice(0, 8)}`)
  assert.equal(f.service.model(f.id, f.remote.modelId).id, f.remote.modelId)
  assert.equal((await f.service.models(f.id)).length, 1)
  assert.doesNotMatch(JSON.stringify(state), /plan-access|plan-refresh|idToken|clientId/)
  const stored = JSON.parse(await readFile(join(f.dataDir, 'chatgpt/connections.json'), 'utf8'))
  assert.ok(stored.profiles[0].tokens.refreshToken)
  await f.reopen()
  assert.deepEqual(f.service.status(), state)
  const repeat = await f.service.beginLogin(f.id)
  const repeatedParams = new URL(repeat.authorizationUrl).searchParams
  assert.equal(repeatedParams.get('client_id'), stored.profiles[0].clientId)
  assert.equal(repeatedParams.get('ext_agent_host_id'), params.get('ext_agent_host_id'))
  assert.equal(repeatedParams.has('agent_name_hint'), false)
  assert.equal(repeatedParams.has('id_token_hint'), false)
  f.service.cancelLogin(repeat.id)
})

test('invalid state, cancellation, timeout and a late exchange never publish usable credentials', async (t) => {
  const f = await fixture(t)
  const attempt = await f.service.beginLogin(await f.service.createProfile())
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
  assert.equal(f.service.status().profiles[0].status, 'signed_out')
  assert.equal(f.service.login(attempt.id).status, 'cancelled')
  assert.equal(f.remote.revoked.length, 1)
  const expired = await f.service.beginLogin(await f.service.createProfile(), 20)
  await delay(40)
  assert.equal(f.service.login(expired.id).status, 'expired')
})

test('declined plan permission retains identity and reconnect reuses registration', async (t) => {
  const f = await fixture(t)
  f.remote.scopes = 'openid profile email'
  await login(f)
  assert.equal(f.service.status().profiles[0].status, 'connected')
  assert.equal(f.service.status().profiles[0].planUsage, false)
  assert.throws(() => f.service.model(f.id, f.remote.modelId), { code: 'permission_missing' })
  const repeat = await f.service.beginLogin(f.id)
  assert.equal(new URL(repeat.authorizationUrl).searchParams.get('prompt'), 'consent')
  f.service.cancelLogin(repeat.id)
})

test('issued client IDs survive failed exchange; account mismatch cannot replace an existing connection', async (t) => {
  const f = await fixture(t)
  f.remote.tokenError = 'invalid_grant'
  const attempt = await f.service.beginLogin(await f.service.createProfile())
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
  assert.throws(() => f.service.model(f.id, f.remote.modelId), { code: 'auth_required' })
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

test('only one account can start a login at a time', async (t) => {
  const f = await fixture(t)
  const firstId = await f.service.createProfile()
  const secondId = await f.service.createProfile()
  const [first, second] = await Promise.allSettled([
    f.service.beginLogin(firstId),
    f.service.beginLogin(secondId),
  ])
  try {
    assert.equal(first.status, 'fulfilled')
    assert.equal(second.status, 'rejected')
    assert.equal(second.reason.code, 'login_pending')
  } finally {
    if (first.status === 'fulfilled') f.service.cancelLogin(first.value.id)
    if (second.status === 'fulfilled') f.service.cancelLogin(second.value.id)
  }
  const next = await f.service.beginLogin(secondId)
  f.service.cancelLogin(next.id)
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
  const id = f.id
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

test(
  'different accounts refresh concurrently without losing either replacement',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await login(f)
    const firstId = f.id
    f.remote.subject = 'second-user'
    await login(f)
    const secondId = f.id
    const storage = new ConnectionStorage(f.dataDir)
    const saved = await storage.load()
    for (const profile of saved.profiles) profile.tokens.expiresAt = Date.now() - 1
    await storage.save(saved)
    await f.reopen()
    const bothStarted = Promise.withResolvers()
    const release = Promise.withResolvers()
    t.signal.addEventListener('abort', () => release.resolve(), { once: true })
    f.remote.delayRefresh = () => {
      if (f.remote.refreshes === 2) bothStarted.resolve()
      return release.promise
    }
    const controller = new AbortController()
    const first = f.service.token(firstId, controller.signal)
    const firstCancelled = assert.rejects(first, { name: 'AbortError' })
    const second = f.service.token(secondId, t.signal)
    const timeout = setTimeout(
      () => bothStarted.reject(new Error('Both refreshes must start')),
      5000,
    )
    timeout.unref()
    let firstRetry
    try {
      await bothStarted.promise
      controller.abort()
      await firstCancelled
      firstRetry = f.service.token(firstId, t.signal)
    } finally {
      clearTimeout(timeout)
      release.resolve()
      if (!firstRetry) {
        controller.abort()
        await Promise.allSettled([first, second])
      }
    }
    const [firstToken, secondToken] = await Promise.all([firstRetry, second])
    assert.equal(f.remote.refreshes, 2)
    const durable = await storage.load()
    assert.equal(durable.profiles.find(({ id }) => id === firstId).tokens.accessToken, firstToken)
    assert.equal(durable.profiles.find(({ id }) => id === secondId).tokens.accessToken, secondToken)
    assert.notEqual(firstToken, secondToken)
  },
)

test(
  'another account remains usable during authorization and its changes survive completion',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await login(f)
    const firstId = f.id
    f.remote.subject = 'second-user'
    await login(f)
    const secondId = f.id
    const secondToken = await f.service.token(secondId, t.signal)
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    t.signal.addEventListener('abort', () => release.resolve(), { once: true })
    f.remote.delayExchange = () => {
      entered.resolve()
      return release.promise
    }
    const attempt = await f.service.beginLogin(firstId)
    const timeout = setTimeout(() => entered.reject(new Error('Authorization did not start')), 5000)
    timeout.unref()
    try {
      await f.remote.authorize(attempt, { subject: 'test-user' })
      await entered.promise
      assert.equal(
        await f.service.token(secondId, AbortSignal.any([t.signal, AbortSignal.timeout(5000)])),
        secondToken,
      )
      assert.deepEqual(await f.service.logout(secondId, async () => {}), { revoked: true })
    } finally {
      clearTimeout(timeout)
      release.resolve()
      await finish(f.service, attempt.id)
    }
    const saved = await new ConnectionStorage(f.dataDir).load()
    assert.ok(saved.profiles.find(({ id }) => id === firstId).tokens)
    assert.equal(saved.profiles.find(({ id }) => id === secondId).tokens, undefined)
  },
)

test('logout revokes the account token and authorization is blocked during runs', async (t) => {
  const f = await fixture(t)
  await login(f)
  f.busy(true)
  await assert.rejects(f.service.beginLogin(f.id), { code: 'connection_busy' })
  let stopped = false
  const result = await f.service.logout(f.id, async () => {
    stopped = true
    f.busy(false)
  })
  assert.equal(stopped, true)
  assert.equal(result.revoked, true)
  assert.throws(() => f.service.model(f.id, f.remote.modelId), { code: 'auth_required' })
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
  const id = f.id
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
  const id = f.id
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
  const cancelled = assert.rejects(f.service.token(f.id, controller.signal), { name: 'AbortError' })
  await began
  const logout = f.service.logout(f.id, async () => controller.abort())
  await cancelled
  release()
  assert.deepEqual(await logout, { revoked: true })
  assert.equal(f.remote.revoked.at(-1), f.remote.latestRefreshToken)
  assert.equal((await storage.load()).profiles[0].tokens, undefined)
  assert.throws(() => f.service.model(f.id, f.remote.modelId), { code: 'auth_required' })
})

test('failed remote revocation clears local tokens and reports the incomplete remote result', async (t) => {
  const f = await fixture(t)
  await login(f)
  f.remote.revocationFails = true
  assert.deepEqual(await f.service.logout(f.id, async () => {}), { revoked: false })
  assert.equal((await new ConnectionStorage(f.dataDir).load()).profiles[0].tokens, undefined)
})

test(
  'multiple accounts isolate credentials, failures and concurrent logout and reauthorization',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await login(f)
    const firstId = f.id
    const firstToken = await f.service.token(firstId, t.signal)
    f.remote.subject = 'another-user'
    await login(f)
    const secondId = f.id
    const secondToken = await f.service.token(secondId, t.signal)
    assert.notEqual(firstId, secondId)
    assert.notEqual(firstToken, secondToken)
    assert.equal(await f.service.token(firstId, t.signal), firstToken)
    assert.equal(f.service.model(firstId, f.remote.modelId).id, f.remote.modelId)
    assert.equal((await f.service.models(secondId)).length, 1)
    const stored = await new ConnectionStorage(f.dataDir).load()
    const firstRefresh = stored.profiles.find(({ id }) => id === firstId).tokens.refreshToken
    const secondRefresh = stored.profiles.find(({ id }) => id === secondId).tokens.refreshToken

    await f.service.failed(firstId, 'permission_missing')
    assert.throws(() => f.service.model(firstId, f.remote.modelId), { code: 'permission_missing' })
    assert.equal(f.service.model(secondId, f.remote.modelId).id, f.remote.modelId)
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const revoke = f.remote.oauth.revoke.bind(f.remote.oauth)
    const heldRevoke = t.mock.method(f.remote.oauth, 'revoke', async (...args) => {
      entered.resolve()
      await release.promise
      return revoke(...args)
    })
    const stop = Promise.withResolvers()
    const logout = f.service.logout(firstId, () => stop.promise)
    try {
      await assert.rejects(f.service.beginLogin(firstId), { code: 'connection_busy' })
      const otherLogin = await f.service.beginLogin(secondId)
      f.service.cancelLogin(otherLogin.id)
      stop.resolve()
      await Promise.race([entered.promise, logout])
      assert.equal(heldRevoke.mock.callCount(), 1)
      assert.throws(() => f.service.model(firstId, f.remote.modelId), { code: 'auth_required' })
      assert.equal(f.service.model(secondId, f.remote.modelId).id, f.remote.modelId)
      assert.equal(
        await f.service.token(secondId, AbortSignal.any([t.signal, AbortSignal.timeout(3000)])),
        secondToken,
      )
      const loginDuringRevocation = await f.service.beginLogin(secondId)
      f.service.cancelLogin(loginDuringRevocation.id)
      const addedDuringRevocation = await f.service.createProfile()
      assert.ok(f.service.status().profiles.some(({ id }) => id === addedDuringRevocation))
    } finally {
      stop.resolve()
      release.resolve()
      await logout
    }
    assert.equal(f.remote.revoked.includes(firstRefresh), true)
    assert.equal(f.remote.revoked.includes(secondRefresh), false)
    assert.equal(await f.service.token(secondId, t.signal), secondToken)
    assert.equal(f.service.status().profiles.find(({ id }) => id === firstId).status, 'signed_out')
    assert.equal(f.service.status().profiles.find(({ id }) => id === secondId).status, 'connected')
    assert.equal((await new ConnectionStorage(f.dataDir).load()).profiles.length, 3)
    assert.equal(f.service.status().pendingLogin, undefined)
  },
)

test(
  'closing rejects a queued login and still persists an in-flight token rotation',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await login(f)
    const firstId = f.id
    const secondId = await f.service.createProfile()
    const storage = new ConnectionStorage(f.dataDir)
    const saved = await storage.load()
    saved.profiles.find(({ id }) => id === firstId).tokens.expiresAt = Date.now() - 1
    await storage.save(saved)
    await f.reopen()
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    t.signal.addEventListener('abort', () => release.resolve(), { once: true })
    f.remote.delayRefresh = () => {
      entered.resolve()
      return release.promise
    }
    const refreshing = f.service.token(firstId, t.signal)
    let beginning, closing
    const listen = t.mock.method(Server.prototype, 'listen', Server.prototype.listen)
    try {
      await Promise.race([entered.promise, refreshing])
      assert.equal(f.remote.refreshes, 1)
      beginning = f.service.beginLogin(firstId).then(
        (attempt) => ({ attempt }),
        (error) => ({ error }),
      )
      closing = f.service.close()
    } finally {
      release.resolve()
    }
    const token = await refreshing
    await closing
    assert.equal((await beginning).error?.code, 'shutting_down')
    assert.equal(
      listen.mock.callCount(),
      0,
      'a queued login must not open a callback listener after closing',
    )
    assert.equal(f.service.status().pendingLogin, undefined)
    const durable = await storage.load()
    assert.equal(durable.profiles.find(({ id }) => id === firstId).tokens.accessToken, token)
    assert.equal(
      durable.profiles.find(({ id }) => id === firstId).tokens.refreshToken,
      f.remote.latestRefreshToken,
    )
    assert.equal(durable.profiles.find(({ id }) => id === secondId).clientId, undefined)
  },
)

test(
  'closing during callback listener startup releases the listener before returning',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t)
    const id = await f.service.createProfile()
    const listening = Promise.withResolvers()
    const resume = Promise.withResolvers()
    t.signal.addEventListener('abort', () => resume.resolve(), { once: true })
    const listen = Server.prototype.listen
    t.mock.method(Server.prototype, 'listen', function (...args) {
      const ready = args.pop()
      return listen.call(this, ...args, () => {
        listening.resolve(this)
        void resume.promise.then(() => ready())
      })
    })
    const beginning = f.service.beginLogin(id).then(
      (attempt) => ({ attempt }),
      (error) => ({ error }),
    )
    let server, closing
    try {
      server = await listening.promise
      closing = f.service.close()
    } finally {
      resume.resolve()
    }
    const port = server.address()?.port
    await closing
    assert.equal((await beginning).error?.code, 'shutting_down')
    assert.equal(server.listening, false)
    assert.equal(f.service.status().pendingLogin, undefined)
    await assert.rejects(fetch(`http://127.0.0.1:${port}/auth/callback`, { signal: t.signal }))
  },
)
