import { setTimeout as delay } from 'node:timers/promises'

export interface EngineInfo {
  engine: 'pi' | 'mock'
  model: { provider: string; id: string }
  configured: boolean
  capabilities: { tools: boolean }
}

export interface EngineRunInput {
  conversationId: string
  message: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  signal: AbortSignal
  onDelta: (delta: string) => void
}

/** Application port: transports and storage do not depend on Pi session types. */
export interface AgentEngine {
  meta(): Promise<EngineInfo>
  run(input: EngineRunInput): Promise<{ text: string }>
  deleteConversation?(conversationId: string): Promise<void>
  close(): Promise<void>
}

export interface PiEngineOptions {
  dataDir: string
  provider?: string
  model?: string
}

export async function createPiEngine(options: PiEngineOptions): Promise<AgentEngine> {
  const { createPiEngine: create } = await import('./pi-engine.ts')
  return create(options)
}

/** Explicit demo/test engine. It never silently replaces an unconfigured Pi. */
export function createMockEngine(): AgentEngine {
  let closed = false
  return {
    meta() {
      return Promise.resolve<EngineInfo>({
        engine: 'mock',
        model: { provider: 'demo', id: 'deterministic' },
        configured: true,
        capabilities: { tools: false },
      })
    },
    async run(input) {
      if (closed) throw new Error('演示引擎已关闭')
      const text = `演示回复：${input.message}\n\n这是显式启用的模拟引擎，未调用真实模型。`
      for (const delta of text.match(/.{1,5}/gs) ?? []) {
        await delay(18, undefined, { signal: input.signal })
        input.onDelta(delta)
      }
      return { text }
    },
    close() {
      closed = true
      return Promise.resolve()
    },
  }
}
