import assert from 'node:assert/strict'
import { httpOperations } from '@learn-electron/contracts/http'
import { schemaValidators } from '@learn-electron/contracts/validation'

// Validate the real wire response, before the client-side normalization/projection.
export async function assertApiResponse(response, path, method = 'GET') {
  if (method === 'HEAD' || method === 'OPTIONS') return response
  const pathname = path.split('?')[0]
  const operation = Object.values(httpOperations).find(
    (entry) =>
      entry.method === method &&
      new RegExp(`^${entry.path.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(pathname),
  )
  const label = `${method} ${path} ${response.status}`
  if (response.status === 204) {
    assert.ok(operation, `Undocumented response: ${label}`)
    assert.equal(operation.responses[204], null, `Expected a documented empty response: ${label}`)
    assert.equal(await response.clone().text(), '', `Expected no body: ${label}`)
    return response
  }
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
    assert.equal(operation?.eventSchema, 'RunEvent', `Undocumented SSE response: ${label}`)
    assert.equal(response.status, operation.successStatus, `Unexpected SSE status: ${label}`)
    return response
  }
  const schema =
    operation?.responses[response.status] ?? (response.status >= 400 ? 'ApiError' : undefined)
  assert.ok(schema, `Undocumented JSON response: ${label}`)
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/)
  assert.equal(
    schemaValidators[schema](await response.clone().json()),
    true,
    `${label} must satisfy OpenAPI ${schema}`,
  )
  return response
}
