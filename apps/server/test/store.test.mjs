import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Store } from '../src/store.ts'

test('run finalization rolls back together and committed results survive reopening', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'learn-electron-finalize-'))
  const path = join(directory, 'app.sqlite')
  let store = new Store(path)
  const control = new DatabaseSync(path)
  t.after(async () => {
    control.close()
    store.close()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('learn-electron-finalize-'))
    await rm(directory, { recursive: true, force: true })
  })

  const conversation = store.create()
  const { run } = store.start(conversation.id, { message: 'hello', requestId: 'finalize-request' })
  store.append(run.id, 'partial')
  const before = store.snapshot(conversation.id)
  // Reject the final sequence update after both message and run writes.
  control.exec(`CREATE TRIGGER reject_finalize BEFORE UPDATE OF sequence ON conversations
    BEGIN SELECT RAISE(ABORT, 'injected finalize failure'); END;`)
  assert.throws(() => store.finalizeRun(run.id, 'final response', 'completed'), /injected finalize/)
  assert.deepEqual(store.snapshot(conversation.id), before)

  control.exec('DROP TRIGGER reject_finalize')
  const finished = store.finalizeRun(run.id, 'final response', 'completed')
  assert.equal(finished.messageSequence, before.sequence + 1)
  assert.equal(finished.runSequence, before.sequence + 2)
  const committed = store.snapshot(conversation.id)
  assert.equal(committed.messages[1].content, 'final response')
  assert.equal(committed.messages[1].status, 'complete')
  assert.equal(committed.run.status, 'completed')
  assert.equal(committed.sequence, finished.runSequence)
  store.close()
  store = new Store(path)
  assert.deepEqual(store.snapshot(conversation.id), committed)
})
