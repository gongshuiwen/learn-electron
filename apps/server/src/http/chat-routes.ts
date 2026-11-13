import type { FastifyInstance } from 'fastify'
import { parseStartRun, parseTitle } from '@learn-electron/contracts'
import { httpOperations as operations } from '@learn-electron/contracts/http'
import { parseCreateConversation, parseModelRef } from '@learn-electron/contracts/models'
import type { ChatService } from '../chat/index.ts'
import { HttpError } from './errors.ts'
import type { ModelService } from '../models/index.ts'
import { streamRun } from './events.ts'
import { methodNotAllowed, parse, readJson, type IdParams } from './shared.ts'

export function registerChatRoutes(
  app: FastifyInstance,
  chat: ChatService,
  models: ModelService | undefined,
): void {
  app.route({
    method: operations.getMeta.method,
    url: operations.getMeta.url,
    handler: async () => chat.meta(),
  })

  app.all(operations.listConversations.url, async (request, reply) => {
    if (request.method === operations.listConversations.method) return chat.listConversations()
    if (request.method === operations.createConversation.method) {
      const body = request.headers['content-type'] ? await readJson(request.raw) : {}
      return reply
        .code(operations.createConversation.successStatus)
        .send(chat.createConversation(parse(parseCreateConversation, body).selection))
    }
    return methodNotAllowed()
  })

  app.all<IdParams<'getConversation'>>(operations.getConversation.url, async (request, reply) => {
    const { id } = request.params
    if (request.method === operations.getConversation.method) return chat.getConversation(id)
    if (request.method === operations.renameConversation.method)
      return chat.renameConversation(id, parse(parseTitle, await readJson(request.raw)))
    if (request.method === operations.deleteConversation.method) {
      await chat.deleteConversation(id)
      return reply.code(operations.deleteConversation.successStatus).send()
    }
    return methodNotAllowed()
  })

  app.all<IdParams<'selectConversationModel'>>(
    operations.selectConversationModel.url,
    async (request) => {
      if (request.method !== operations.selectConversationModel.method) return methodNotAllowed()
      if (!models) throw new HttpError(409, 'engine_disabled', '当前引擎不支持模型选择')
      return chat.selectConversationModel(
        request.params.id,
        parse(parseModelRef, await readJson(request.raw)),
      )
    },
  )

  app.all<IdParams<'startRun'>>(operations.startRun.url, async (request, reply) => {
    if (request.method !== operations.startRun.method) return methodNotAllowed()
    const body = parse(parseStartRun, await readJson(request.raw))
    return reply
      .code(operations.startRun.successStatus)
      .send(await chat.startRun(request.params.id, body))
  })

  app.all<IdParams<'cancelRun'>>(operations.cancelRun.url, (request) => {
    if (request.method === operations.cancelRun.method) return chat.cancelRun(request.params.id)
    chat.getRun(request.params.id)
    return methodNotAllowed()
  })

  app.all<IdParams<'streamRunEvents'>>(operations.streamRunEvents.url, async (request, reply) => {
    if (request.method === operations.streamRunEvents.method)
      return streamRun(chat, request.params.id, reply)
    chat.getRun(request.params.id)
    return methodNotAllowed()
  })
}
