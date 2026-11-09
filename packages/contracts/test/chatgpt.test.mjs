import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseChatGPTLogin,
  parseChatGPTModels,
  parseChatGPTState,
  parseLoginRequest,
  parseModelSelection,
  parseProfileId,
} from '../src/chatgpt.ts'
import { CHATGPT_USAGE_URL, isChatGPTUrl } from '../src/native.ts'

test('ChatGPT contracts accept public DTOs and reject malformed auth/model requests', () => {
  assert.deepEqual(parseLoginRequest({}), {})
  assert.deepEqual(parseLoginRequest({ profileId: 'saved-connection' }), {
    profileId: 'saved-connection',
  })
  for (const invalid of [null, {}, { profileId: '../secret' }, { profileId: 3 }])
    assert.throws(() => parseProfileId(invalid))
  for (const invalid of [null, {}, { modelId: '' }, { modelId: 'm'.repeat(201) }])
    assert.throws(() => parseModelSelection(invalid))
  const state = {
    enabled: true,
    activeId: 'profile',
    profiles: [
      {
        id: 'profile',
        label: 'user@example.com',
        status: 'connected',
        planUsage: true,
        modelId: 'model',
      },
    ],
  }
  assert.deepEqual(parseChatGPTState(state), state)
  const pendingLogin = {
    id: 'attempt',
    status: 'pending',
    authorizationUrl: 'https://auth.openai.com/api/accounts/authorize',
    expiresAt: '2026-11-09T12:00:00Z',
  }
  assert.deepEqual(parseChatGPTState({ ...state, pendingLogin }).pendingLogin, pendingLogin)
  assert.throws(() =>
    parseChatGPTState({ ...state, pendingLogin: { ...pendingLogin, status: 'completed' } }),
  )
  assert.throws(() =>
    parseChatGPTState({ ...state, profiles: [{ ...state.profiles[0], status: 'unknown' }] }),
  )
  assert.throws(() =>
    parseChatGPTState({ ...state, profiles: [{ ...state.profiles[0], status: ['connected'] }] }),
  )
  assert.throws(() => parseChatGPTModels([{ id: 'model' }]))
  assert.throws(() => parseChatGPTLogin({ id: 'login', status: 'unknown' }))
})

test('external browser capability accepts only exact ChatGPT destinations and secret-free loopback authorization', () => {
  const params = new URLSearchParams({
    redirect_uri: 'http://127.0.0.1:4321/auth/callback',
    client_id: 'client',
    state: 'state',
    nonce: 'nonce',
    code_challenge: 'challenge',
    code_challenge_method: 'S256',
    response_type: 'code',
  })
  const authorization = `https://auth.openai.com/api/accounts/authorize?${params}`
  assert.equal(isChatGPTUrl(authorization), true)
  assert.equal(isChatGPTUrl(CHATGPT_USAGE_URL), true)
  for (const invalid of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://chatgpt.com.evil.example/settings/usage',
    'https://auth.openai.com.evil.example/api/accounts/authorize',
    'https://evil@chatgpt.com/settings/usage',
    'https://chatgpt.com:8443/settings/usage',
    `${CHATGPT_USAGE_URL}?redirect=evil`,
    authorization.replace('127.0.0.1', 'evil.example'),
    `${authorization}&id_token_hint=secret`,
    `${authorization}&access_token=secret`,
    authorization.replace('%2Fauth%2Fcallback', '%2Fother'),
  ])
    assert.equal(isChatGPTUrl(invalid), false, invalid)
})
