import type { ServerResponse } from 'node:http'
import type { FastifyReply } from 'fastify'
import type { RunEvent } from '@learn-electron/contracts'
import type { ChatService } from '../chat/index.ts'

const MAX_STREAM_BUFFER = 1024 * 1024

function sendEvent(response: ServerResponse, event: RunEvent): void {
  if (response.destroyed || response.writableEnded) return
  if (response.writableLength > MAX_STREAM_BUFFER) {
    response.destroy()
    return
  }
  response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)
}

export async function streamRun(chat: ChatService, id: string, reply: FastifyReply): Promise<void> {
  const response = reply.raw
  const subscription = await chat.subscribe(id, {
    event: (event) => sendEvent(response, event),
    close: (error) => {
      if (error) response.destroy()
      else response.end()
    },
  })
  if (response.destroyed) {
    subscription.unsubscribe()
    reply.hijack()
    return
  }
  response.once('close', subscription.unsubscribe)
  reply.hijack()
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  })
  response.flushHeaders()
  sendEvent(response, subscription.snapshot)
  if (!subscription.active) {
    response.end()
    return
  }
  const heartbeat = setInterval(() => {
    if (response.writableLength > MAX_STREAM_BUFFER) response.destroy()
    else response.write(': heartbeat\n\n')
  }, 15_000)
  heartbeat.unref()
  response.once('close', () => clearInterval(heartbeat))
}
