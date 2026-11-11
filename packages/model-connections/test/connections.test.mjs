import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseConnectionConfig,
  parseHeaders,
  parseModelDefinition,
  parseModelRef,
} from '../src/index.ts'

const connection = {
  name: 'Custom gateway',
  protocol: 'openai-chat',
  baseUrl: 'https://example.com/proxy/v1/',
  authentication: 'api-key',
  models: [{ id: 'vendor/new-model' }],
}

test('a model reference identifies a concrete provider instance and model', () => {
  assert.deepEqual(parseModelRef({ instanceId: 'primary', modelId: 'vendor/model' }), {
    instanceId: 'primary',
    modelId: 'vendor/model',
  })
  assert.throws(() => parseModelRef({ instanceId: 'primary' }))
  assert.throws(() => parseModelRef({ kind: 'route', routeId: 'daily' }))
})

test('connection configuration accepts arbitrary model IDs and keeps application defaults independent of an SDK catalog', () => {
  const value = parseConnectionConfig(connection)
  assert.equal(value.baseUrl, 'https://example.com/proxy/v1')
  assert.deepEqual(value.models[0], {
    id: 'vendor/new-model',
    name: 'vendor/new-model',
    contextWindow: 32768,
    maxOutputTokens: 4096,
  })
  assert.equal(
    parseConnectionConfig({
      ...connection,
      baseUrl: 'http://127.0.0.1:11434/v1',
      authentication: 'none',
    }).authentication,
    'none',
  )
  assert.deepEqual(parseModelDefinition({ id: 'tiny', contextWindow: 2048 }), {
    id: 'tiny',
    name: 'tiny',
    contextWindow: 2048,
    maxOutputTokens: 2048,
  })
})

test('connection validation rejects ambiguous endpoints, unsupported protocols and inconsistent model limits', () => {
  for (const baseUrl of [
    'file:///data',
    'https://key@example.com/v1',
    'https://example.com?api_key=secret',
    'https://example.com/#fragment',
  ])
    assert.throws(() => parseConnectionConfig({ ...connection, baseUrl }))
  for (const patch of [
    { protocol: 'sdk-private-api' },
    { models: [{ id: 'x', contextWindow: 1024, maxOutputTokens: 2048 }] },
    { models: [{ id: 'x' }, { id: 'x' }] },
    { models: [{ id: '../allowed-id', contextWindow: NaN }] },
    { compatibility: { execute: 'command' } },
    { protocol: 'openai-responses', compatibility: { supportsStore: false } },
    { protocol: 'google-generative', authentication: 'none' },
  ])
    assert.throws(() => parseConnectionConfig({ ...connection, ...patch }))
})

test('credential headers remain literal and reject HTTP framing and header injection', () => {
  assert.deepEqual(parseHeaders({ 'X-Gateway-Key': '!command $ENV ${SECRET}' }), {
    'X-Gateway-Key': '!command $ENV ${SECRET}',
  })
  for (const headers of [
    { Host: 'evil' },
    { 'Content-Length': '100' },
    { 'X-Key': 'secret\r\nAuthorization: bad' },
    JSON.parse('{"__proto__":"value"}'),
  ])
    assert.throws(() => parseHeaders(headers))
})
