import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadOpenApi, renderContracts } from '../../../scripts/generate-contracts.mjs'
import { httpOperations } from '../src/generated/http.ts'
import { schemaValidators } from '@learn-electron/contracts/validation'

test('external OpenAPI changes reach generated types, validators and HTTP operation metadata', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'learn-electron-openapi-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await cp(new URL('../../../api/', import.meta.url), directory, { recursive: true })
  const edit = async (file, change) => {
    const target = join(directory, file)
    const value = parse(await readFile(target, 'utf8'))
    change(value)
    await writeFile(target, stringify(value))
  }
  await edit('components/schemas/chat.yaml', (schemas) => schemas.RunStatus.enum.push('queued'))
  await edit('components/schemas/models.yaml', (schemas) => {
    schemas.ModelId['x-utf16-maxLength'] = 201
    schemas.ConnectionConfigInput.properties.name['x-utf16-maxLength'] = 101
    schemas.ModelDefinitionInput.properties.contextWindow.maximum = 20_000_000
  })
  await edit('paths/chat.yaml', (paths) => {
    const responses = paths.conversationRuns.post.responses
    responses['203'] = responses['202']
    delete responses['202']
  })
  const document = await loadOpenApi(pathToFileURL(join(directory, 'openapi.yaml')))
  const files = await renderContracts(document)
  assert.match(files['types.ts'], /'queued'/)
  assert.match(files['http.ts'], /successStatus: 203/)
  assert.match(files['http.ts'], /'x-utf16-maxLength': 101/)
  const generated = await import(
    `data:text/javascript;base64,${Buffer.from(files['validators.js']).toString('base64')}`
  )
  assert.equal(generated.RunStatus('queued'), true)
  assert.equal(schemaValidators.RunStatus('queued'), false)
  // Replace only the generated artifact; HTTP parsers must not reapply handwritten structural limits.
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('../src/models.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [
      {
        name: 'changed-openapi',
        setup(builder) {
          builder.onLoad({ filter: /generated[\\/]validators\.js$/ }, () => ({
            contents: files['validators.js'],
            loader: 'js',
          }))
        },
      },
    ],
  })
  const contracts = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
  )
  assert.equal(
    contracts.parseModelRef({ instanceId: 'provider', modelId: 'm'.repeat(201) }).modelId.length,
    201,
  )
  assert.equal(
    contracts.parseModels([
      { id: 'm', name: 'M', contextWindow: 10_000_001, maxOutputTokens: 1 },
    ])[0].contextWindow,
    10_000_001,
  )
  assert.equal(
    contracts.parseSaveProvider({
      name: 'n'.repeat(101),
      protocol: 'openai-chat',
      baseUrl: 'https://example.invalid/v1',
      authentication: 'none',
      models: [],
    }).name.length,
    101,
  )
  assert.match(files['types.ts'], /interface HttpPathParameters/)
  await edit('components/responses.yaml', (responses) => {
    responses.ApiError.content['application/json'].schema.$ref = './schemas/missing.yaml#/ApiError'
  })
  await assert.rejects(loadOpenApi(pathToFileURL(join(directory, 'openapi.yaml'))), /missing\.yaml/)
})

test('generated operation metadata links request schemas and JSON, empty and SSE responses', () => {
  assert.equal(httpOperations.startRun.request, 'StartRunRequest')
  assert.equal(httpOperations.deleteConversation.responses[204], null)
  assert.equal(httpOperations.streamRunEvents.eventSchema, 'RunEvent')
  for (const operation of Object.values(httpOperations)) {
    if (operation.request) assert.equal(typeof schemaValidators[operation.request], 'function')
    for (const name of Object.values(operation.responses))
      if (name) assert.equal(typeof schemaValidators[name], 'function')
  }
})

test('HTTP metadata bundles without loading schema validators', async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/generated/http.ts', import.meta.url))],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    treeShaking: false,
    metafile: true,
    write: false,
  })
  assert.equal(
    Object.keys(result.metafile.inputs).some((file) => /[\\/]validators\.js$/.test(file)),
    false,
  )
})
