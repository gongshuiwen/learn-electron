import assert from 'node:assert/strict'
import test from 'node:test'
import { parseChatGPTLogin, parseChatGPTModels, parseChatGPTProfile } from '../src/chatgpt.ts'
import { CHATGPT_USAGE_URL, isChatGPTUrl } from '../src/native.ts'

test('ChatGPT contracts accept public DTOs and reject malformed authorization status', () => {
  const profile = {
    id: 'profile',
    name: 'user@example.com',
    status: 'connected',
    planUsage: true,
  }
  assert.deepEqual(parseChatGPTProfile(profile), profile)
  for (const status of ['authorizing', 'busy'])
    assert.equal(parseChatGPTProfile({ ...profile, status }).status, status)
  const pendingLogin = {
    id: 'attempt',
    status: 'pending',
    authorizationUrl: 'https://auth.openai.com/api/accounts/authorize',
    expiresAt: '2026-11-09T12:00:00Z',
  }
  assert.deepEqual(parseChatGPTLogin(pendingLogin), pendingLogin)
  assert.throws(() => parseChatGPTLogin({ ...pendingLogin, status: 'completed' }))
  assert.equal(
    parseChatGPTLogin({ ...pendingLogin, status: 'completed', instanceId: 'account-1' }).instanceId,
    'account-1',
  )
  assert.throws(() => parseChatGPTProfile({ ...profile, status: 'unknown' }))
  assert.throws(() => parseChatGPTProfile({ ...profile, status: ['connected'] }))
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
