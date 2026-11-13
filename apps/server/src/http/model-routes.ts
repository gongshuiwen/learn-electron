import type { FastifyInstance } from 'fastify'
import type { AgentEngine } from '@learn-electron/agent-runtime'
import { httpOperations as operations } from '@learn-electron/contracts/http'
import {
  modelAdapters,
  parseCreateProvider,
  parseModelRef,
  parseProviderTest,
  parseSaveProvider,
} from '@learn-electron/contracts/models'
import type { ChatService } from '../chat/index.ts'
import type { ChatGPTProvider } from '../chatgpt/index.ts'
import { HttpError } from './errors.ts'
import type { ModelService } from '../models/index.ts'
import { methodNotAllowed, parse, readJson, type IdParams } from './shared.ts'

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

  app.route({
    method: operations.listModelAdapters.method,
    url: operations.listModelAdapters.url,
    handler: () => modelAdapters,
  })

  app.all(operations.getProviders.url, async (request, reply) => {
    if (!models && request.method === operations.getProviders.method)
      return { defaultSelection: null, instances: [], chatgpt: { enabled: false } }
    const service = requireModels()
    if (request.method === operations.getProviders.method) return service.status()
    if (request.method === operations.createProvider.method) {
      const body = parse(parseCreateProvider, await readJson(request.raw))
      return reply
        .code(operations.createProvider.successStatus)
        .send('kind' in body ? await service.createAccount() : await service.save(body))
    }
    return methodNotAllowed()
  })

  app.all<IdParams<'updateProvider'>>(operations.updateProvider.url, async (request) => {
    const service = requireModels()
    if (request.method === operations.updateProvider.method)
      return service.save(parse(parseSaveProvider, await readJson(request.raw)), request.params.id)
    if (request.method === operations.deleteProvider.method)
      return service.remove(request.params.id)
    return methodNotAllowed()
  })

  app.all<IdParams<'listProviderModels'>>(operations.listProviderModels.url, async (request) => {
    const service = requireModels()
    if (request.method === operations.listProviderModels.method)
      return service.models(request.params.id)
    return methodNotAllowed()
  })

  app.all<IdParams<'refreshProviderModels'>>(
    operations.refreshProviderModels.url,
    async (request) => {
      const service = requireModels()
      if (request.method === operations.refreshProviderModels.method)
        return service.refreshModels(request.params.id)
      return methodNotAllowed()
    },
  )

  app.all<IdParams<'testProvider'>>(operations.testProvider.url, async (request, reply) => {
    const service = requireModels()
    if (request.method !== operations.testProvider.method) return methodNotAllowed()
    const { modelId } = parse(parseProviderTest, await readJson(request.raw))
    const execute = engine.testConnection?.bind(engine)
    if (!execute) throw new HttpError(409, 'engine_disabled', '当前引擎不支持连接测试')
    await service.test(request.params.id, modelId, execute)
    return reply.code(operations.testProvider.successStatus).send()
  })

  app.all<IdParams<'beginProviderLogin'>>(
    operations.beginProviderLogin.url,
    async (request, reply) => {
      const provider = requireChatGPT(request.params.id)
      if (request.method === operations.beginProviderLogin.method)
        return reply
          .code(operations.beginProviderLogin.successStatus)
          .send(await provider.beginLogin(request.params.id))
      return methodNotAllowed()
    },
  )

  app.all<IdParams<'logoutProvider'>>(operations.logoutProvider.url, async (request) => {
    const provider = requireChatGPT(request.params.id)
    if (request.method === operations.logoutProvider.method)
      return provider.logout(request.params.id, () => chat.cancelAll(request.params.id))
    return methodNotAllowed()
  })

  app.all<IdParams<'getLoginAttempt'>>(operations.getLoginAttempt.url, (request) => {
    if (!chatgpt) throw new HttpError(409, 'engine_disabled', '演示模式不支持登录')
    if (request.method === operations.getLoginAttempt.method)
      return chatgpt.login(request.params.id)
    return methodNotAllowed()
  })

  app.all<IdParams<'cancelLoginAttempt'>>(
    operations.cancelLoginAttempt.url,
    async (request, reply) => {
      if (!chatgpt) throw new HttpError(409, 'engine_disabled', '演示模式不支持登录')
      if (request.method !== operations.cancelLoginAttempt.method) return methodNotAllowed()
      chatgpt.cancelLogin(request.params.id)
      return reply.code(operations.cancelLoginAttempt.successStatus).send()
    },
  )

  app.route({
    method: operations.selectDefaultModel.method,
    url: operations.selectDefaultModel.url,
    handler: async (request) => {
      if (!models) throw new HttpError(409, 'engine_disabled', '当前引擎不支持模型选择')
      return models.select(parse(parseModelRef, await readJson(request.raw)))
    },
  })
}
