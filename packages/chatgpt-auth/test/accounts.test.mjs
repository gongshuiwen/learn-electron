import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import { ChatGPTAuth, PLAN_SCOPE } from '../src/index.ts'

test('account storage and authorized model metadata remain independent of the execution runtime', async () => {
  const tokens = (accessToken) => ({
    accessToken,
    refreshToken: `refresh-${accessToken}`,
    expiresAt: Date.now() + 300_000,
    scopes: [PLAN_SCOPE],
  })
  let saved = {
    version: 2,
    hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
    profiles: [
      {
        id: 'first',
        clientId: 'first-client',
        tokens: tokens('first'),
        models: [{ id: 'future-model', name: 'Future model' }],
      },
      {
        id: 'second',
        clientId: 'second-client',
        tokens: tokens('second'),
        models: [{ id: 'another-model', name: 'Another model' }],
      },
    ],
  }
  const revoked = []
  const auth = await ChatGPTAuth.create({
    agentName: 'Test app',
    storage: {
      async load() {
        return structuredClone(saved)
      },
      async save(state) {
        saved = structuredClone(state)
      },
    },
    oauth: {
      resource: 'https://example.com/v1',
      authorization(params) {
        return `https://example.com/authorize?${params}`
      },
      async models() {
        return [{ id: 'future-model', name: 'Refreshed model' }]
      },
      async revoke(clientId, token) {
        revoked.push([clientId, token])
      },
    },
  })
  try {
    assert.equal(auth.model('first', 'future-model').id, 'future-model')
    const models = await auth.models('first')
    assert.deepEqual(models, [{ id: 'future-model', name: 'Future model' }])
    models[0].name = 'changed by caller'
    assert.equal(auth.model('first', 'future-model').name, 'Future model')
    const refreshed = await auth.models('first', true)
    refreshed[0].name = 'changed after refresh'
    assert.equal(auth.model('first', 'future-model').name, 'Refreshed model')
    assert.equal(await auth.token('second', new AbortController().signal), 'second')
    assert.doesNotMatch(JSON.stringify(auth.status()), /refresh-|accessToken|clientId/)
    assert.deepEqual(await auth.logout('first', async () => {}), { revoked: true })
    assert.deepEqual(revoked, [['first-client', 'refresh-first']])
    assert.equal(saved.profiles[0].tokens, undefined)
    assert.equal(saved.profiles[1].tokens.accessToken, 'second')
    assert.equal(await auth.token('second', new AbortController().signal), 'second')
    const attempt = await auth.beginLogin(await auth.createProfile())
    assert.equal(new URL(attempt.authorizationUrl).searchParams.get('agent_name_hint'), 'Test app')
    auth.cancelLogin(attempt.id)
  } finally {
    await auth.close()
  }
})

test('a failed stop releases close without clearing credentials', { timeout: 5000 }, async () => {
  const state = {
    version: 2,
    hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
    profiles: [
      {
        id: 'account',
        clientId: 'client',
        tokens: {
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 300_000,
          scopes: [PLAN_SCOPE],
        },
        models: [],
      },
    ],
  }
  const auth = await ChatGPTAuth.create({
    agentName: 'Test app',
    storage: {
      async load() {
        return state
      },
      async save() {
        assert.fail('unexpected write')
      },
    },
    oauth: {
      async revoke() {
        assert.fail('unexpected revocation')
      },
    },
  })
  const stopping = Promise.withResolvers()
  const failure = new Error('tasks did not stop')
  const logout = auth.logout('account', () => stopping.promise)
  const rejected = assert.rejects(logout, { message: failure.message })
  let closed = false
  const closing = auth.close().then(() => {
    closed = true
  })
  try {
    await nextTurn()
    assert.equal(closed, false)
    stopping.reject(failure)
    await rejected
    await closing
    assert.equal(state.profiles[0].tokens.accessToken, 'access')
  } finally {
    stopping.reject(failure)
  }
})
