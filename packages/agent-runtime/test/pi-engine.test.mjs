import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking } from '@earendil-works/pi-ai'
import { AgentSession, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent'
import { createPiEngine } from '../src/index.ts'

// Only replace the provider boundary. Sessions, event delivery, persistence and
// cancellation use the real SDK, without changing the production engine API.
async function fixture(t, responses) {
  const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-pi-session-'))
  const provider = fauxProvider({ tokenSize: { min: 2, max: 2 }, tokensPerSecond: 200 })
  provider.setResponses(responses)
  const createRuntime = ModelRuntime.create
  t.mock.method(ModelRuntime, 'create', async function (options) {
    const runtime = await createRuntime.call(this, options)
    runtime.registerNativeProvider(provider.provider)
    await runtime.refresh({ allowNetwork: false })
    return runtime
  })
  t.mock.method(globalThis, 'fetch', () => assert.fail('Pi adapter tests must remain offline'))

  const sessions = new Map()
  const subscribe = AgentSession.prototype.subscribe
  const dispose = AgentSession.prototype.dispose
  t.mock.method(AgentSession.prototype, 'subscribe', function (listener) {
    const state = sessions.get(this) ?? { subscriptions: 0, unsubscriptions: 0, disposals: 0 }
    state.subscriptions++
    sessions.set(this, state)
    const unsubscribe = subscribe.call(this, listener)
    return () => {
      state.unsubscriptions++
      unsubscribe()
    }
  })
  t.mock.method(AgentSession.prototype, 'dispose', function () {
    sessions.get(this).disposals++
    return dispose.call(this)
  })
  const engines = []
  t.after(async () => {
    await Promise.all(engines.map((engine) => engine.close()))
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()))
    await rm(dataDir, { recursive: true, force: true })
  })
  async function create() {
    const engine = await createPiEngine({ dataDir, provider: 'faux', model: 'faux-1' })
    engines.push(engine)
    assert.equal((await engine.meta()).configured, true)
    return engine
  }
  function assertReleased() {
    assert.ok(sessions.size > 0, 'a real SDK session must have been used')
    for (const state of sessions.values()) {
      assert.equal(state.unsubscriptions, state.subscriptions)
      assert.ok(state.disposals >= 1, 'a completed or closed session must be disposed')
    }
  }
  return { create, assertReleased }
}

function input(overrides = {}) {
  return {
    conversationId: randomUUID(),
    message: 'First question',
    history: [],
    signal: new AbortController().signal,
    onDelta() {},
    ...overrides,
  }
}

test(
  'Pi streams text only and restores native context after engine recreation',
  { timeout: 10_000 },
  async (t) => {
    let continuation
    const { create, assertReleased } = await fixture(t, [
      fauxAssistantMessage([fauxThinking('private reasoning'), fauxText('First answer')]),
      (context) => {
        continuation = structuredClone(context)
        return fauxAssistantMessage('Second answer')
      },
    ])
    const first = await create()
    const conversationId = randomUUID()
    const deltas = []
    assert.deepEqual(
      await first.run(input({ conversationId, onDelta: (delta) => deltas.push(delta) })),
      { text: 'First answer' },
    )
    assert.ok(deltas.length > 1)
    assert.equal(deltas.join(''), 'First answer')
    await first.close()

    const restored = await create()
    assert.deepEqual(
      await restored.run(
        input({
          conversationId,
          message: 'Second question',
          history: [
            { role: 'user', content: 'display projection must not replace native context' },
          ],
        }),
      ),
      { text: 'Second answer' },
    )
    const dialogue = continuation.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role,
        text:
          typeof message.content === 'string'
            ? message.content
            : message.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join(''),
      }))
    assert.deepEqual(dialogue, [
      { role: 'user', text: 'First question' },
      { role: 'assistant', text: 'First answer' },
      { role: 'user', text: 'Second question' },
    ])
    assertReleased()
  },
)

test(
  'Pi accepts a successful recovery after context overflow and native compaction',
  { timeout: 10_000 },
  async (t) => {
    const settings = SettingsManager.inMemory
    t.mock.method(SettingsManager, 'inMemory', function (options) {
      // Retain a short tail so a tiny offline conversation can exercise real compaction.
      return settings.call(this, {
        ...options,
        compaction: { ...options.compaction, keepRecentTokens: 1 },
      })
    })
    const { create, assertReleased } = await fixture(t, [
      fauxAssistantMessage('First answer'),
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'prompt is too long: 220000 tokens > 200000 maximum',
      }),
      fauxAssistantMessage('History summary'),
      fauxAssistantMessage('Turn prefix summary'),
      fauxAssistantMessage('Recovered answer'),
    ])
    const compactions = []
    const subscribe = AgentSession.prototype.subscribe
    t.mock.method(AgentSession.prototype, 'subscribe', function (listener) {
      return subscribe.call(this, (event) => {
        if (event.type === 'compaction_end') compactions.push(event)
        listener(event)
      })
    })
    const engine = await create()
    const conversationId = randomUUID()
    await engine.run(input({ conversationId }))
    const deltas = []
    assert.deepEqual(
      await engine.run(
        input({
          conversationId,
          message: 'Second question',
          history: [{ role: 'assistant', content: 'First answer' }],
          onDelta: (delta) => deltas.push(delta),
        }),
      ),
      { text: 'Recovered answer' },
    )
    assert.equal(deltas.join(''), 'Recovered answer')
    assert.equal(compactions.length, 1)
    assert.equal(compactions[0].reason, 'overflow')
    assert.equal(compactions[0].aborted, false)
    assert.equal(compactions[0].willRetry, true)
    assert.ok(compactions[0].result)
    assertReleased()
  },
)

test(
  'Pi cancellation reaches the provider and releases the session',
  { timeout: 10_000 },
  async (t) => {
    let providerSignal
    const { create, assertReleased } = await fixture(t, [
      (_context, options) => {
        providerSignal = options.signal
        return fauxAssistantMessage('A response that must stop after the first chunk')
      },
      fauxAssistantMessage('A later request succeeds'),
    ])
    const engine = await create()
    const controller = new AbortController()
    const conversationId = randomUUID()
    const deltas = []
    await assert.rejects(
      engine.run(
        input({
          conversationId,
          signal: controller.signal,
          onDelta(delta) {
            deltas.push(delta)
            controller.abort()
          },
        }),
      ),
      { name: 'AbortError' },
    )
    assert.equal(providerSignal.aborted, true)
    assert.ok(deltas.length > 0)
    assert.ok(deltas.join('').length < 'A response that must stop after the first chunk'.length)
    await engine.deleteConversation(conversationId)
    assert.deepEqual(await engine.run(input()), { text: 'A later request succeeds' })
    assertReleased()
  },
)

for (const stopReason of ['error', 'aborted']) {
  test(
    `Pi rejects provider ${stopReason} events and releases the session`,
    { timeout: 10_000 },
    async (t) => {
      const { create, assertReleased } = await fixture(t, [
        fauxAssistantMessage('Partial output', {
          stopReason,
          errorMessage: 'private-provider-secret',
        }),
      ])
      const engine = await create()
      const deltas = []
      await assert.rejects(
        engine.run(input({ onDelta: (delta) => deltas.push(delta) })),
        (error) => {
          assert.match(error.message, /模型请求失败/)
          assert.ok(!error.message.includes('private-provider-secret'))
          return true
        },
      )
      assert.equal(deltas.join(''), 'Partial output')
      assertReleased()
    },
  )
}

test('Pi closes active work and refuses subsequent runs', { timeout: 10_000 }, async (t) => {
  const started = Promise.withResolvers()
  const { create, assertReleased } = await fixture(t, [
    (_context, options) => {
      started.resolve(options.signal)
      return new Promise((resolve) => {
        options.signal.addEventListener(
          'abort',
          () => resolve(fauxAssistantMessage('', { stopReason: 'aborted' })),
          { once: true },
        )
      })
    },
  ])
  const engine = await create()
  const rejected = assert.rejects(engine.run(input()), /模型请求失败/)
  const signal = await started.promise
  await engine.close()
  await rejected
  assert.equal(signal.aborted, true)
  await assert.rejects(engine.run(input()), /模型服务已关闭/)
  assertReleased()
})
