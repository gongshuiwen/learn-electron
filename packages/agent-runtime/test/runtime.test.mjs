import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMockEngine, createPiEngine } from '../src/index.ts'

test('Pi metadata uses application connections and ignores legacy environment credentials', async () => {
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
  process.env.PI_MODEL = '__legacy_model__'
  const engines = []
  try {
    const target = {
      instanceId: 'configured-connection',
      revision: 1,
      kind: 'endpoint',
      provider: 'Custom',
      protocol: 'openai-chat',
      baseUrl: 'https://example.invalid/v1',
      authentication: 'api-key',
      model: { id: 'manual-model', name: 'Manual', contextWindow: 32768, maxOutputTokens: 4096 },
      compatibility: {},
    }
    const configured = await createPiEngine({
      dataDir,
      credentials: {
        credentials: () => Promise.resolve({ apiKey: 'explicit-key', headers: {} }),
        failed: () => Promise.resolve(),
      },
    })
    engines.push(configured)
    const meta = await configured.meta()
    assert.equal('apiVersion' in meta, false)
    assert.equal(meta.engine, 'pi')
    assert.equal(meta.configured, false)
    assert.equal(meta.model.provider, 'unconfigured')
    assert.ok(meta.model.id)
    assert.equal(meta.capabilities.tools, false)
    await assert.rejects(
      configured.run({
        target,
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

    const noKey = await createPiEngine({ dataDir })
    engines.push(noKey)
    assert.equal((await noKey.meta()).configured, false)

    await assert.rejects(
      noKey.run({
        conversationId: 'configuration-test',
        message: 'Do not send',
        history: [],
        signal: new globalThis.AbortController().signal,
        onDelta: () => assert.fail('An unconfigured Pi cannot produce output'),
      }),
      /模型凭据不可用/,
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
