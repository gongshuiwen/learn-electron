import type { FastifyInstance } from 'fastify'
import type { AgentEngine } from '@learn-electron/agent-runtime'
import {
  modelAdapters,
  parseModelRef,
  parseProviderTest,
  parseSaveProvider,
} from '@learn-electron/contracts/models'
import { isObject } from '@learn-electron/model-connections'
import type { ChatService } from '../chat-service.ts'
import type { ChatGPTProvider } from '../chatgpt/provider.ts'
import { HttpError } from '../errors.ts'
import type { ModelService } from '../model-service.ts'
import { ID_PARAM, methodNotAllowed, parse, readJson, type IdParams } from './shared.ts'

export function registerModelRoutes(
  app: FastifyInstance,
  chat: ChatService,
  engine: AgentEngine,
  models: ModelService | undefined,
  chatgpt: ChatGPTProvider | undefined,
): void {
  function requireModels(): ModelService {
    if (!models) throw new HttpError(409, 'engine_disabled', '演示模式不支持模型供应商配置')
    return models
  }

  function requireChatGPT(id: string): ChatGPTProvider {
    const service = requireModels()
    if (!chatgpt) throw new HttpError(409, 'engine_disabled', '当前引擎不支持授权')
    const instance = service.status().instances.find((item) => item.id === id)
    if (!instance) throw new HttpError(404, 'provider_not_found', '模型供应商实例不存在')
    if (instance.kind !== 'chatgpt')
      throw new HttpError(409, 'auth_unsupported', '该实例不支持网页登录')
    return chatgpt
  }

  app.get('/model-adapters', () => modelAdapters)

  app.all('/model-providers', async (request, reply) => {
    if (!models && request.method === 'GET')
      return { defaultSelection: null, instances: [], chatgpt: { enabled: false } }
    const service = requireModels()
    if (request.method === 'GET') return service.status()
    if (request.method === 'POST') {
      const body = await readJson(request.raw)
      return reply
        .code(201)
        .send(
          isObject(body) && body.kind === 'chatgpt'
            ? await service.createAccount()
            : await service.save(parse(parseSaveProvider, body)),
        )
    }
    return methodNotAllowed()
  })

  app.all<IdParams>(`/model-providers/${ID_PARAM}`, async (request) => {
    const service = requireModels()
    if (request.method === 'PATCH')
      return service.save(parse(parseSaveProvider, await readJson(request.raw)), request.params.id)
    if (request.method === 'DELETE') return service.remove(request.params.id)
    return methodNotAllowed()
  })

  app.all<IdParams>(`/model-providers/${ID_PARAM}/models`, async (request) => {
    const service = requireModels()
    if (request.method === 'GET') return service.models(request.params.id)
    return methodNotAllowed()
  })

  app.all<IdParams>(`/model-providers/${ID_PARAM}/models/refresh`, async (request) => {
    const service = requireModels()
    if (request.method === 'POST') return service.refreshModels(request.params.id)
    return methodNotAllowed()
  })

  app.all<IdParams>(`/model-providers/${ID_PARAM}/test`, async (request, reply) => {
    const service = requireModels()
    if (request.method !== 'POST') return methodNotAllowed()
    const { modelId } = parse(parseProviderTest, await readJson(request.raw))
    const execute = engine.testConnection?.bind(engine)
    if (!execute) throw new HttpError(409, 'engine_disabled', '当前引擎不支持连接测试')
    await service.test(request.params.id, modelId, execute)
    return reply.code(204).send()
  })

  app.all<IdParams>(`/model-providers/${ID_PARAM}/auth/attempts`, async (request, reply) => {
    const provider = requireChatGPT(request.params.id)
    if (request.method === 'POST')
      return reply.code(201).send(await provider.beginLogin(request.params.id))
    return methodNotAllowed()
  })

  app.all<IdParams>(`/model-providers/${ID_PARAM}/auth/logout`, async (request) => {
    const provider = requireChatGPT(request.params.id)
    if (request.method === 'POST')
      return provider.logout(request.params.id, () => chat.cancelAll(request.params.id))
    return methodNotAllowed()
  })

  app.all<IdParams>(`/model-auth-attempts/${ID_PARAM}`, (request) => {
    if (!chatgpt) throw new HttpError(409, 'engine_disabled', '演示模式不支持登录')
    if (request.method === 'GET') return chatgpt.login(request.params.id)
    return methodNotAllowed()
  })

  app.all<IdParams>(`/model-auth-attempts/${ID_PARAM}/cancel`, async (request, reply) => {
    if (!chatgpt) throw new HttpError(409, 'engine_disabled', '演示模式不支持登录')
    if (request.method !== 'POST') return methodNotAllowed()
    chatgpt.cancelLogin(request.params.id)
    return reply.code(204).send()
  })

  app.put('/model', async (request) => {
    if (!models) throw new HttpError(409, 'engine_disabled', '当前引擎不支持模型选择')
    return models.select(parse(parseModelRef, await readJson(request.raw)))
  })
}
