import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import SwaggerParser from '@apidevtools/swagger-parser'
import Ajv from 'ajv/dist/2020.js'
import { _ } from 'ajv/dist/compile/codegen/index.js'
import standaloneCode from 'ajv/dist/standalone/index.js'
import { build } from 'esbuild'
import { compile } from 'json-schema-to-typescript'
import { format } from 'oxfmt'

const root = new URL('../', import.meta.url)
const source = new URL('api/openapi.yaml', root)
const output = new URL('packages/contracts/src/generated/', root)
const banner =
  '// Generated from api/openapi.yaml. DO NOT EDIT.\n// Run npm run generate:contracts.\n'
const schemaId = 'urn:learn-electron:http'
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'])

function schemaName(schema) {
  const name = schema?.$ref?.replace('#/components/schemas/', '')
  if (!name || name === schema.$ref)
    throw new Error('HTTP payloads must reference a component schema')
  return name
}

function resolveReference(document, value) {
  if (!value?.$ref) return value
  if (!value.$ref.startsWith('#/')) throw new Error('Expected an internal reference after bundling')
  return value.$ref
    .slice(2)
    .split('/')
    .reduce((entry, key) => entry[key], document)
}

function jsonSchema(value) {
  if (Array.isArray(value)) return value.map(jsonSchema)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === '$ref' ? entry.replace('#/components/schemas/', '#/$defs/') : jsonSchema(entry),
    ]),
  )
}

async function formatted(name, text, options) {
  const result = await format(name, text, options)
  if (result.errors.length) throw new Error(`Cannot format generated ${name}`)
  return result.code
}

export function loadOpenApi(sourceUrl = source) {
  return SwaggerParser.bundle(fileURLToPath(sourceUrl), { resolve: { http: false } })
}

export async function renderContracts(document) {
  // Validate a clone: the parser dereferences objects in place.
  await SwaggerParser.validate(structuredClone(document))
  const schemas = document.components.schemas
  const names = Object.keys(schemas)
  const definitions = jsonSchema(schemas)
  const schema = {
    $id: schemaId,
    title: 'HttpSchemas',
    type: 'object',
    properties: Object.fromEntries(names.map((name) => [name, { $ref: `#/$defs/${name}` }])),
    required: names,
    $defs: definitions,
  }
  const ajv = new Ajv({ inlineRefs: false, code: { source: true, esm: true, lines: true } })
  // These explicit OpenAPI extensions retain the existing JavaScript string.length contract.
  for (const [keyword, trimmed] of [
    ['x-utf16-maxLength', false],
    ['x-trimmed-utf16-maxLength', true],
  ]) {
    ajv.addKeyword({
      keyword,
      type: 'string',
      schemaType: 'number',
      metaSchema: { type: 'integer', minimum: 0 },
      code(context) {
        const { data, schemaCode } = context
        context.fail(
          trimmed ? _`${data}.trim().length > ${schemaCode}` : _`${data}.length > ${schemaCode}`,
        )
      },
    })
  }
  ajv.addSchema({ $id: schemaId, $defs: definitions })
  const exports = Object.fromEntries(names.map((name) => [name, `${schemaId}#/$defs/${name}`]))
  const validators = standaloneCode(ajv, exports)
  const bundled = await build({
    stdin: { contents: validators, resolveDir: fileURLToPath(root) },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    minify: true,
    legalComments: 'none',
  })
  const declarations = names
    .map(
      (name) => `export declare function ${name}(value: unknown): value is HttpSchemas['${name}']`,
    )
    .join('\n')
  const operations = {}
  const pathParameters = {}
  const constraintKeywords = new Set([
    'minimum',
    'maximum',
    'x-utf16-maxLength',
    'x-trimmed-utf16-maxLength',
  ])
  const constraints = {}
  for (const [name, schema] of Object.entries(schemas)) {
    const properties = {}
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      const limits = Object.fromEntries(
        Object.entries({ ...resolveReference(document, property), ...property }).filter(
          ([keyword]) => constraintKeywords.has(keyword),
        ),
      )
      if (Object.keys(limits).length) properties[key] = limits
    }
    if (Object.keys(properties).length) constraints[name] = properties
  }
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!methods.has(method)) continue
      const id = operation.operationId
      if (!id || operations[id]) throw new Error(`Missing or duplicate operationId: ${path}`)
      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])].map(
        (value) => resolveReference(document, value),
      )
      const params = parameters.filter((parameter) => parameter.in === 'path')
      if (params.length)
        pathParameters[id] = {
          type: 'object',
          properties: Object.fromEntries(
            params.map((parameter) => [parameter.name, jsonSchema(parameter.schema)]),
          ),
          required: params
            .filter((parameter) => parameter.required)
            .map((parameter) => parameter.name),
        }
      const responses = {}
      let eventSchema
      for (const [status, raw] of Object.entries(operation.responses)) {
        const response = resolveReference(document, raw)
        const json = response.content?.['application/json']
        responses[status] = json ? schemaName(json.schema) : null
        const events = response.content?.['text/event-stream']?.['x-event-schema']
        if (events) eventSchema = schemaName(events)
      }
      const body = resolveReference(document, operation.requestBody)
      operations[id] = {
        method: method.toUpperCase(),
        path,
        // Preserve v1's regex path matching and deferred body parsing in Fastify.
        url: path.replace(/\{([^}]+)\}/g, (_match, name) => {
          const parameter = parameters.find((value) => value.in === 'path' && value.name === name)
          if (!parameter?.schema?.pattern) throw new Error(`Missing path pattern: ${path}`)
          return `:${name}(${parameter.schema.pattern})`
        }),
        request: body ? schemaName(body.content['application/json'].schema) : null,
        successStatus: Number(Object.keys(responses).find((status) => /^2\d\d$/.test(status))),
        responses,
        ...(eventSchema ? { eventSchema } : {}),
      }
    }
  }
  const metadata = `${banner}
export type { HttpPathParameters } from './types.ts'
export const API_VERSION = ${JSON.stringify(schemas.ApiVersion.const)} as const
export const API_PREFIX = ${JSON.stringify(document.servers[0].url)}
export const MAX_BODY_BYTES = ${JSON.stringify(document['x-max-body-bytes'])}
export const httpOperations = ${JSON.stringify(operations, null, 2)} as const
export const httpConstraints = ${JSON.stringify(constraints, null, 2)} as const
`
  const options = JSON.parse(await readFile(new URL('.oxfmtrc.json', root), 'utf8'))
  return {
    'types.ts': await formatted(
      'types.ts',
      await compile(
        {
          ...schema,
          $defs: {
            ...definitions,
            HttpPathParameters: {
              type: 'object',
              properties: pathParameters,
              required: Object.keys(pathParameters),
            },
          },
        },
        'HttpSchemas',
        {
          bannerComment: banner.trim(),
          additionalProperties: false,
          ignoreMinAndMaxItems: true,
          unknownAny: true,
          format: false,
          unreachableDefinitions: true,
        },
      ),
      options,
    ),
    'validators.js': banner + bundled.outputFiles[0].text,
    'validators.d.ts': await formatted(
      'validators.d.ts',
      `${banner}import type { HttpSchemas } from './types.ts'\n${declarations}\n`,
      options,
    ),
    'http.ts': await formatted('http.ts', metadata, options),
  }
}

export async function generateContracts({ check = false } = {}) {
  const document = await loadOpenApi()
  const files = await renderContracts(document)
  if (!check) await mkdir(output, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const target = new URL(name, output)
    if (check) {
      const existing = await readFile(target, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return ''
        throw error
      })
      if (existing !== content) throw new Error(`${name} is stale; run npm run generate:contracts`)
    } else await writeFile(target, content)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await generateContracts({ check: process.argv.includes('--check') })
  console.log(
    process.argv.includes('--check') ? 'HTTP contracts are up to date' : 'Generated HTTP contracts',
  )
}
