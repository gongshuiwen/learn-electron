import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseProvidersState,
  parseSaveProvider,
  parseModelRef,
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
  assert.deepEqual(parseModelRef({ instanceId: 'connection-1', modelId: 'vendor/model' }), {
    instanceId: 'connection-1',
    modelId: 'vendor/model',
  })
})

test('connection read DTOs strip secret fields and reject malformed status metadata', () => {
  const entry = {
    ...config,
    id: 'connection-1',
    kind: 'endpoint',
    revision: 1,
    hasCredential: true,
    hasHeaders: true,
    apiKey: 'private-key',
    headers: { Authorization: 'private-header' },
  }
  const state = {
    defaultSelection: { instanceId: entry.id, modelId: 'custom-model' },
    instances: [
      entry,
      {
        id: 'account-1',
        kind: 'chatgpt',
        name: 'Account',
        status: 'connected',
        planUsage: true,
        tokens: 'private-token',
      },
    ],
    chatgpt: { enabled: true },
  }
  const decoded = parseProvidersState(state)
  assert.doesNotMatch(JSON.stringify(decoded), /private|apiKey|Authorization/)
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
})
