import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseProvidersState,
  parseSaveProvider,
  parseModelRef,
  parseCreateConversation,
  parseCreateProvider,
  parseProviderTest,
  parseModelAdapters,
  parseModelStatus,
  parseModels,
  parseCredentialHeaders,
} from '@learn-electron/contracts/models'

const config = {
  name: 'Gateway',
  protocol: 'openai-chat',
  baseUrl: 'https://example.com/v1',
  authentication: 'api-key',
  models: [{ id: 'custom-model' }],
}
test('connection writes distinguish retained, replaced and explicitly cleared credentials', () => {
  assert.equal('apiKey' in parseSaveProvider(config), false)
  assert.equal(parseSaveProvider({ ...config, apiKey: '!literal-key' }).apiKey, '!literal-key')
  assert.equal(parseSaveProvider({ ...config, apiKey: null }).apiKey, null)
  assert.deepEqual(parseSaveProvider({ ...config, headers: {} }).headers, {})
  assert.throws(() => parseSaveProvider({ ...config, apiKey: '' }))
})

test('the public models entry parses a concrete model reference', () => {
  assert.deepEqual(
    parseModelRef({ instanceId: 'connection-1', modelId: ' vendor/model ', extra: true }),
    {
      instanceId: 'connection-1',
      modelId: 'vendor/model',
    },
  )
  assert.throws(() => parseModelRef({ instanceId: 'connection-1', modelId: 1 }))
  assert.throws(() => parseModelRef({ modelId: 'vendor/model' }))
})

test('provider and conversation inputs use generated schemas while retaining domain normalization', () => {
  assert.deepEqual(parseCreateProvider({ kind: 'chatgpt', ignored: 'extra' }), { kind: 'chatgpt' })
  assert.equal(parseCreateProvider(config).vendor, 'custom')
  assert.deepEqual(parseCreateConversation({}), {})
  assert.deepEqual(
    parseCreateConversation({
      selection: { instanceId: 'provider', modelId: ' model ', extra: true },
    }),
    { selection: { instanceId: 'provider', modelId: 'model' } },
  )
  assert.deepEqual(parseProviderTest({ modelId: '  vendor/model  ' }), { modelId: 'vendor/model' })
  for (const [decode, invalid] of [
    [parseCreateProvider, { kind: 'endpoint' }],
    [parseCreateConversation, { selection: null }],
    [parseProviderTest, { modelId: ' ' }],
    [parseSaveProvider, { ...config, protocol: 'unknown' }],
    [parseSaveProvider, { ...config, compatibility: { unknown: true } }],
    [parseSaveProvider, { ...config, models: [{ id: 'm', contextWindow: 1, maxOutputTokens: 2 }] }],
    [parseSaveProvider, { ...config, headers: { Host: 'example.invalid' } }],
  ])
    assert.throws(() => decode(invalid))
})

test('adapter and model status responses reject incompatible structures and strip extra fields', () => {
  const adapter = { id: 'openai-chat', name: 'OpenAI', authentication: ['none'] }
  assert.deepEqual(parseModelAdapters([{ ...adapter, extra: true }]), [adapter])
  assert.throws(() => parseModelAdapters([{ ...adapter, authentication: [] }]))
  const status = {
    selection: null,
    target: null,
    model: { provider: 'unconfigured', id: 'unconfigured' },
    configured: false,
  }
  assert.deepEqual(parseModelStatus({ ...status, apiKey: 'test-only-secret' }), status)
  const ref = { instanceId: 'provider', modelId: ' model ', extra: true }
  assert.deepEqual(parseModelStatus({ ...status, selection: ref, target: ref }), {
    ...status,
    selection: { instanceId: 'provider', modelId: 'model' },
    target: { instanceId: 'provider', modelId: 'model' },
  })
  assert.throws(() => parseModelStatus({ ...status, target: {} }))
})

test('connection read DTOs strip secret fields and reject malformed status metadata', () => {
  const entry = {
    ...config,
    vendor: 'custom',
    compatibility: {},
    models: [{ id: 'custom-model', name: 'Custom', contextWindow: 32768, maxOutputTokens: 4096 }],
    id: 'connection-1',
    kind: 'endpoint',
    revision: 1,
    hasCredential: true,
    hasHeaders: true,
    apiKey: 'private-key',
    headers: { Authorization: 'private-header' },
  }
  const state = {
    defaultSelection: { instanceId: entry.id, modelId: ' custom-model ', extra: true },
    instances: [
      entry,
      {
        id: 'account-1',
        kind: 'chatgpt',
        vendor: 'openai',
        name: 'Account',
        status: 'connected',
        planUsage: true,
        tokens: 'private-token',
      },
    ],
    chatgpt: {
      enabled: true,
      pendingLogin: {
        id: 'attempt',
        status: 'pending',
        authorizationUrl: 'https://auth.openai.com/api/accounts/authorize',
        expiresAt: '2026-11-09T12:00:00Z',
        error: 'Retry authorization',
        tokens: 'private-login-token',
        instanceId: 'private-unused-instance',
      },
    },
  }
  const decoded = parseProvidersState(state)
  assert.doesNotMatch(JSON.stringify(decoded), /private|apiKey|Authorization/)
  assert.deepEqual(decoded.defaultSelection, { instanceId: entry.id, modelId: 'custom-model' })
  assert.deepEqual(decoded.chatgpt.pendingLogin, {
    id: 'attempt',
    status: 'pending',
    authorizationUrl: 'https://auth.openai.com/api/accounts/authorize',
    expiresAt: '2026-11-09T12:00:00Z',
    error: 'Retry authorization',
  })
  assert.equal(decoded.instances[0].models[0].id, 'custom-model')
  assert.throws(() =>
    parseProvidersState({ ...state, instances: [{ ...entry, hasCredential: 'yes' }] }),
  )
  assert.throws(() => parseProvidersState({ ...state, defaultSelection: { instanceId: entry.id } }))
  assert.throws(() =>
    parseProvidersState({
      ...state,
      instances: [{ ...state.instances[1], planUsage: 'yes' }],
    }),
  )
  for (const field of ['vendor', 'compatibility']) {
    const incomplete = { ...entry }
    delete incomplete[field]
    assert.throws(() => parseProvidersState({ ...state, instances: [incomplete] }))
  }
  assert.throws(() =>
    parseProvidersState({ ...state, instances: [{ ...entry, models: [{ id: 'custom-model' }] }] }),
  )
  assert.throws(() =>
    parseProvidersState({ ...state, instances: [{ ...state.instances[1], vendor: 'other' }] }),
  )
  for (const invalid of [
    { ...state.chatgpt.pendingLogin, status: 'completed' },
    { ...state.chatgpt.pendingLogin, expiresAt: 1 },
  ])
    assert.throws(() =>
      parseProvidersState({ ...state, chatgpt: { enabled: true, pendingLogin: invalid } }),
    )
  assert.throws(() => parseModels([{ id: 'custom-model' }]))
  assert.throws(() => parseModels([{ ...entry.models[0], maxOutputTokens: 100000 }]))
  assert.throws(() => parseModels([entry.models[0], entry.models[0]]))
})

test('credential headers share generated structure checks and preserve the domain framing guard', () => {
  const headers = { 'X-Test': '!literal ${NOT_EVALUATED}' }
  assert.deepEqual(parseCredentialHeaders(headers), headers)
  for (const invalid of [
    null,
    [],
    { key: 1 },
    { 'Invalid Name': 'value' },
    { Host: 'example.invalid' },
    { 'X-Test': 'injected\r\nheader' },
    JSON.parse('{"__proto__":"value"}'),
  ])
    assert.throws(() => parseCredentialHeaders(invalid))
})
