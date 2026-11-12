import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ModelService } from '../../src/model-service.ts'
import { ProtectedFile } from '../../src/protected-file.ts'

const config = {
  name: 'Endpoint',
  protocol: 'openai-chat',
  baseUrl: 'http://127.0.0.1:1/v1',
  authentication: 'none',
  models: [{ id: 'model' }],
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-model-service-'))
  const accounts = {
    view: () => ({ instances: [], chatgpt: { enabled: true } }),
    close: async () => {},
  }
  const service = await ModelService.create(dataDir, accounts, () => false)
  return {
    service,
    async savedState() {
      return JSON.parse(await readFile(join(dataDir, 'models', 'connections.json'), 'utf8'))
    },
    async dispose() {
      await service.close()
      assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()))
      assert.ok(basename(dataDir).startsWith('learn-electron-model-service-'))
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

test(
  'a connection probe isolates other instances and remains tracked during shutdown',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture()
    const { service } = f
    const first = (await service.save(config)).instances[0]
    const second = (await service.save(config)).instances[1]
    const started = Promise.withResolvers()
    const finish = Promise.withResolvers()
    const probe = service.test(first.id, 'model', async (_target, signal) => {
      started.resolve(signal)
      await finish.promise
    })
    let selection
    let closing
    t.after(async () => {
      finish.resolve()
      await Promise.allSettled([probe, selection, closing])
      await f.dispose()
    })

    const signal = await started.promise
    selection = service.select({ instanceId: second.id, modelId: 'model' })
    const selected = await Promise.race([
      selection.then(() => true),
      delay(3000, false, { ref: false }),
    ])
    assert.equal(selected, true, 'another instance must not wait for a remote probe')
    await assert.rejects(service.save(config, first.id), { code: 'connection_busy' })
    const persisted = await f.savedState()
    assert.deepEqual(persisted.defaultSelection, { instanceId: second.id, modelId: 'model' })

    let closed = false
    closing = service.close().then(() => {
      closed = true
    })
    await setImmediate()
    assert.equal(signal.aborted, true)
    assert.equal(closed, false, 'shutdown must wait for the in-flight probe')
    finish.resolve()
    await Promise.all([probe, closing])
  },
)

test(
  'shutdown finishes an active configuration write and rejects queued writes',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture()
    const { service } = f
    const started = Promise.withResolvers()
    const finish = Promise.withResolvers()
    const save = ProtectedFile.prototype.save
    let firstWrite = true
    t.mock.method(ProtectedFile.prototype, 'save', async function (state) {
      if (firstWrite) {
        firstWrite = false
        started.resolve()
        await finish.promise
      }
      return save.call(this, state)
    })
    const active = service.save({ ...config, name: 'First' })
    let queued
    let closing
    t.after(async () => {
      finish.resolve()
      await Promise.allSettled([active, queued, closing])
      await f.dispose()
    })
    await started.promise
    queued = service.save({ ...config, name: 'Queued' })
    const rejected = assert.rejects(queued, { code: 'shutting_down' })
    await setImmediate()
    closing = service.close()
    finish.resolve()
    await Promise.all([active, rejected, closing])
    const persisted = await f.savedState()
    assert.deepEqual(
      persisted.instances.map(({ name }) => name),
      ['First'],
    )
  },
)
