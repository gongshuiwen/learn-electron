import assert from 'node:assert/strict'
import test from 'node:test'
import {
  API_VERSION,
  parseConversation,
  parseConversations,
  parseConversationSnapshot,
  parseRun,
  parseRunEvent,
  parseServiceMeta,
  parseStartRun,
  parseTitle,
} from '../src/index.ts'

const timestamp = '2026-01-01T00:00:00.000Z'
const conversation = {
  id: 'conversation-1',
  title: 'A conversation',
  createdAt: timestamp,
  updatedAt: timestamp,
}
const message = {
  id: 'message-1',
  role: 'assistant',
  content: 'Hello',
  createdAt: timestamp,
  status: 'complete',
}
const run = {
  id: 'run-1',
  conversationId: conversation.id,
  status: 'completed',
  createdAt: timestamp,
  updatedAt: timestamp,
}
const snapshot = { conversation, messages: [message], run, sequence: 3 }
const envelope = {
  apiVersion: API_VERSION,
  conversationId: conversation.id,
  runId: run.id,
  sequence: snapshot.sequence,
}
const delta = { ...envelope, type: 'message.delta', messageId: message.id, delta: 'Hello' }

test('start requests normalize message text and retain the idempotency key', () => {
  assert.deepEqual(parseStartRun({ message: '  hello\n', requestId: 'request-0001' }), {
    message: 'hello',
    requestId: 'request-0001',
  })
  assert.equal(
    parseStartRun({ message: 'x'.repeat(32_000), requestId: 'a'.repeat(128) }).message.length,
    32_000,
  )
  assert.equal(parseStartRun({ message: 'x', requestId: 'a'.repeat(8) }).requestId.length, 8)
})

test('start requests reject invalid bodies, message bounds and request keys', () => {
  for (const body of [
    null,
    [],
    'hello',
    {},
    { message: '  ', requestId: 'request-0001' },
    { message: 'x'.repeat(32_001), requestId: 'request-0001' },
    ...['short', 'a'.repeat(129), 'request/0001'].map((requestId) => ({
      message: 'hello',
      requestId,
    })),
  ]) {
    assert.throws(() => parseStartRun(body), Error)
  }
})

test('titles are trimmed and must fit the public length limit', () => {
  assert.equal(parseTitle({ title: '  My chat  ' }), 'My chat')
  assert.equal(parseTitle({ title: 'x'.repeat(100) }).length, 100)
  for (const body of [null, [], {}, { title: 1 }, { title: '  ' }, { title: 'x'.repeat(101) }]) {
    assert.throws(() => parseTitle(body), Error)
  }
})

test('service metadata validates its version, model and capabilities', () => {
  const meta = {
    apiVersion: API_VERSION,
    engine: 'pi',
    model: { provider: 'test', id: 'model' },
    configured: false,
    capabilities: { tools: false },
  }
  assert.deepEqual(parseServiceMeta(meta), meta)
  assert.throws(() => parseServiceMeta({ ...meta, apiVersion: API_VERSION + 1 }), /API 版本不兼容/)
  for (const value of [
    null,
    { ...meta, engine: 'unknown' },
    { ...meta, model: { provider: 'test' } },
    { ...meta, configured: 'false' },
    { ...meta, capabilities: { tools: 0 } },
  ]) {
    assert.throws(() => parseServiceMeta(value), /格式不兼容/)
  }
})

test('HTTP responses validate conversations, lists, runs and snapshots', () => {
  for (const [parse, valid, invalid] of [
    [parseConversation, conversation, { ...conversation, title: null }],
    [parseConversations, [conversation], [conversation, {}]],
    [parseRun, run, { ...run, status: 'unknown' }],
    [parseConversationSnapshot, snapshot, { ...snapshot, messages: [{}] }],
  ]) {
    assert.deepEqual(parse(valid), valid)
    assert.throws(() => parse(invalid), /格式不兼容/)
    assert.throws(() => parse(null), /格式不兼容/)
  }
  assert.deepEqual(parseConversations([]), [])
})

test('each public stream event preserves its required fields', () => {
  const events = [
    { ...envelope, type: 'snapshot', snapshot },
    delta,
    { ...envelope, type: 'message.completed', message },
    { ...envelope, type: 'run.updated', run },
  ]
  for (const event of events) {
    assert.deepEqual(parseRunEvent(event), event)
  }
})

test('stream envelopes reject incompatible versions and invalid sequence numbers', () => {
  for (const value of [
    null,
    [],
    { ...delta, apiVersion: API_VERSION + 1 },
    { ...delta, conversationId: null },
    { ...delta, runId: 1 },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '3'].map((sequence) => ({ ...delta, sequence })),
  ]) {
    assert.throws(() => parseRunEvent(value), /不兼容/)
  }
})

test('stream payloads reject incomplete data and mismatched run identity', () => {
  for (const value of [
    { ...envelope, type: 'unknown' },
    { ...delta, delta: undefined },
    { ...delta, messageId: undefined },
    { ...envelope, type: 'message.completed', message: { ...message, status: 'unknown' } },
    { ...envelope, type: 'run.updated', run: { ...run, id: 'another-run' } },
    { ...envelope, type: 'run.updated', run: { ...run, conversationId: 'another-conversation' } },
    { ...envelope, type: 'run.updated', run: { ...run, status: 'unknown' } },
  ]) {
    assert.throws(() => parseRunEvent(value), /不兼容/)
  }
})

test('snapshots must belong to the envelope conversation and share its sequence', () => {
  for (const value of [
    { ...snapshot, conversation: { ...conversation, id: 'another-conversation' } },
    { ...snapshot, run: { ...run, conversationId: 'another-conversation' } },
    { ...snapshot, sequence: snapshot.sequence + 1 },
    { ...snapshot, messages: [{ ...message, content: null }] },
  ]) {
    assert.throws(() => parseRunEvent({ ...envelope, type: 'snapshot', snapshot: value }), /不兼容/)
  }
})

test('an old run stream accepts the conversation snapshot with a newer current run or no run', () => {
  for (const current of [{ ...run, id: 'newer-run', status: 'running' }, null]) {
    const value = { ...envelope, type: 'snapshot', snapshot: { ...snapshot, run: current } }
    assert.deepEqual(parseRunEvent(value), value)
  }
})
