import type { FastifyInstance } from 'fastify'
import { parseStartRun, parseTitle } from '@learn-electron/contracts'
import { parseCreateConversation, parseModelRef } from '@learn-electron/contracts/models'
import type { ChatService } from '../chat/index.ts'
import { HttpError } from './errors.ts'
import type { ModelService } from '../models/index.ts'
import { streamRun } from './events.ts'
import { ID_PARAM, methodNotAllowed, parse, readJson, type IdParams } from './shared.ts'

export function registerChatRoutes(
  app: FastifyInstance,
  chat: ChatService,
  models: ModelService | undefined,
): void {
  app.get('/meta', async () => chat.meta())

  app.all('/conversations', async (request, reply) => {
    if (request.method === 'GET') return chat.listConversations()
    if (request.method === 'POST') {
      const body = request.headers['content-type'] ? await readJson(request.raw) : {}
      return reply
        .code(201)
        .send(chat.createConversation(parse(parseCreateConversation, body).selection))
    }
    return methodNotAllowed()
  })

  app.all<IdParams>(`/conversations/${ID_PARAM}`, async (request, reply) => {
    const { id } = request.params
    if (request.method === 'GET') return chat.getConversation(id)
    if (request.method === 'PATCH')
      return chat.renameConversation(id, parse(parseTitle, await readJson(request.raw)))
    if (request.method === 'DELETE') {
      await chat.deleteConversation(id)
      return reply.code(204).send()
    }
    return methodNotAllowed()
  })

  app.all<IdParams>(`/conversations/${ID_PARAM}/model`, async (request) => {
    if (request.method !== 'PUT') return methodNotAllowed()
    if (!models) throw new HttpError(409, 'engine_disabled', '当前引擎不支持模型选择')
    return chat.selectConversationModel(
      request.params.id,
      parse(parseModelRef, await readJson(request.raw)),
    )
  })

  app.all<IdParams>(`/conversations/${ID_PARAM}/runs`, async (request, reply) => {
    if (request.method !== 'POST') return methodNotAllowed()
    const body = parse(parseStartRun, await readJson(request.raw))
    return reply.code(202).send(await chat.startRun(request.params.id, body))
  })

  app.all<IdParams>(`/runs/${ID_PARAM}/cancel`, (request) => {
    if (request.method === 'POST') return chat.cancelRun(request.params.id)
    chat.getRun(request.params.id)
    return methodNotAllowed()
  })

  app.all<IdParams>(`/runs/${ID_PARAM}/events`, async (request, reply) => {
    if (request.method === 'GET') return streamRun(chat, request.params.id, reply)
    chat.getRun(request.params.id)
    return methodNotAllowed()
  })
}
