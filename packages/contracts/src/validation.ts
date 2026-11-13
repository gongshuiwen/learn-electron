import * as schemaValidators from './generated/validators.js'
import type { HttpSchemas } from './generated/types.ts'

export { schemaValidators }

export function parseSchema<K extends keyof HttpSchemas>(
  name: K,
  value: unknown,
  message: string,
): HttpSchemas[K] {
  if (!isSchema(name, value)) throw new Error(message)
  return value
}

export function isSchema<K extends keyof HttpSchemas>(
  name: K,
  value: unknown,
): value is HttpSchemas[K] {
  return schemaValidators[name](value)
}
