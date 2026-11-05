import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Store } from '../src/store.ts'
import { migrate } from '../src/migrations.ts'

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

test('an unversioned database is backed up and adopted without losing history or request keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'learn-electron-migrate-'))
  const path = join(directory, 'app.sqlite')
  const legacy = new DatabaseSync(path)
  let store
  try {
    legacy.exec(await readFile(new URL('./fixtures/legacy-v0.sql', import.meta.url), 'utf8'))
    assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, 0)
    const conversationId = 'legacy-conversation'
    const runId = 'legacy-run'
    const request = { message: 'saved question', requestId: 'saved-request' }
    // Keep this connection open so committed sample data remains in the WAL during backup.
    assert.ok((await stat(`${path}-wal`)).size > 0)

    store = new Store(path)
    assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, 1)
    const snapshot = store.snapshot(conversationId)
    assert.equal(snapshot.conversation.title, 'Saved conversation')
    assert.equal(snapshot.sequence, 3)
    assert.equal(snapshot.run.status, 'completed')
    assert.deepEqual(
      snapshot.messages.map((message) => message.content),
      ['saved question', 'saved answer'],
    )
    assert.equal(store.findRequest(conversationId, request).id, runId)
    const backups = (await readdir(directory)).filter((name) => name.endsWith('.bak'))
    assert.equal(backups.length, 1)
    const backupPath = join(directory, backups[0])
    const backup = new DatabaseSync(backupPath, { readOnly: true })
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 0)
      assert.equal(
        backup.prepare('SELECT content FROM messages WHERE role = ?').get('assistant').content,
        'saved answer',
      )
      assert.equal(
        backup.prepare('SELECT request_id FROM runs WHERE id = ?').get(runId).request_id,
        request.requestId,
      )
    } finally {
      backup.close()
    }
    store.close()
    store = undefined
    store = new Store(path)
    assert.deepEqual(store.snapshot(conversationId), snapshot)
    assert.equal(store.findRequest(conversationId, request).id, runId)
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith('.bak')),
      backups,
    )
  } finally {
    store?.close()
    legacy?.close()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('learn-electron-migrate-'))
    await rm(directory, { recursive: true, force: true })
  }
})

test('migration failures roll back schema and version, and newer databases are rejected', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY)')
    assert.throws(() => migrate(db, ':memory:'), /conversation_id/)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0)
    assert.deepEqual(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map((row) => row.name),
      ['messages'],
    )
    db.exec('PRAGMA user_version = 99')
    assert.throws(() => migrate(db, ':memory:'), /更新版本/)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 99)
  } finally {
    db.close()
  }
})
