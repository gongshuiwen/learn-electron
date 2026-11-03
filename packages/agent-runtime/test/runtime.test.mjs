import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMockEngine, createPiEngine } from '../src/index.ts'

test('Pi metadata uses explicit server configuration without model network requests', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-runtime-'))
  const originalFetch = globalThis.fetch
  const originalKey = process.env.OPENAI_API_KEY
  const originalModel = process.env.PI_MODEL
  const requests = []
  globalThis.fetch = async (...args) => {
    requests.push(args)
    throw new Error('Runtime configuration must not fetch a remote model or invoke a provider')
  }
  process.env.OPENAI_API_KEY = 'runtime-test-not-a-real-key'
  delete process.env.PI_MODEL
  const engines = []
  try {
    const configured = await createPiEngine({ dataDir, provider: 'openai' })
    engines.push(configured)
    const meta = await configured.meta()
    assert.equal('apiVersion' in meta, false)
    assert.equal(meta.engine, 'pi')
    assert.equal(meta.configured, true)
    assert.equal(meta.model.provider, 'openai')
    assert.ok(meta.model.id)
    assert.equal(meta.capabilities.tools, false)
    await assert.rejects(
      configured.run({
        conversationId: 'missing-native-session',
        message: 'Continue',
        history: [{ role: 'user', content: 'Old projected message' }],
        signal: new globalThis.AbortController().signal,
        onDelta: () => assert.fail('Missing native context must not invoke a provider'),
      }),
      /模型上下文文件缺失/,
    )

    const removedId = randomUUID()
    const retainedId = randomUUID()
    const removedDirectory = join(dataDir, 'sessions', removedId)
    const retainedDirectory = join(dataDir, 'sessions', retainedId)
    await mkdir(removedDirectory)
    await mkdir(retainedDirectory)
    await writeFile(join(removedDirectory, 'session.jsonl'), 'private conversation')
    await writeFile(join(retainedDirectory, 'session.jsonl'), 'retain this conversation')
    assert.equal(typeof configured.deleteConversation, 'function')
    await assert.rejects(configured.deleteConversation('../workspace'), /UUID/)
    await configured.deleteConversation(removedId)
    await assert.rejects(access(removedDirectory), { code: 'ENOENT' })
    assert.equal(
      await readFile(join(retainedDirectory, 'session.jsonl'), 'utf8'),
      'retain this conversation',
    )

    delete process.env.OPENAI_API_KEY
    const noKey = await createPiEngine({ dataDir, provider: 'openai' })
    engines.push(noKey)
    assert.equal((await noKey.meta()).configured, false)

    const missing = await createPiEngine({
      dataDir,
      provider: '__missing_provider__',
      model: '__missing_model__',
    })
    engines.push(missing)
    const missingMeta = await missing.meta()
    assert.equal(missingMeta.engine, 'pi')
    assert.equal(missingMeta.configured, false)
    assert.deepEqual(missingMeta.model, {
      provider: '__missing_provider__',
      id: '__missing_model__',
    })
    await assert.rejects(
      missing.run({
        conversationId: 'configuration-test',
        message: 'Do not send',
        history: [],
        signal: new globalThis.AbortController().signal,
        onDelta: () => assert.fail('An unconfigured Pi cannot produce output'),
      }),
      /未配置可用模型/,
    )
    assert.equal(requests.length, 0)
    assert.deepEqual((await readdir(dataDir)).sort(), ['sessions', 'workspace'])
  } finally {
    await Promise.all(engines.map((engine) => engine.close()))
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
    if (originalModel === undefined) delete process.env.PI_MODEL
    else process.env.PI_MODEL = originalModel
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('mock is explicitly identified, streams text, and respects cancellation', async () => {
  const engine = createMockEngine()
  const meta = await engine.meta()
  assert.equal(meta.engine, 'mock')
  assert.equal('apiVersion' in meta, false)
  const controller = new globalThis.AbortController()
  const deltas = []
  await assert.rejects(
    engine.run({
      conversationId: 'mock-test',
      message: '你好',
      history: [],
      signal: controller.signal,
      onDelta(delta) {
        deltas.push(delta)
        controller.abort()
      },
    }),
    { name: 'AbortError' },
  )
  assert.equal(deltas.length, 1)
  await engine.close()
})
