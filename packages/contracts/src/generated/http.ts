// Generated from api/openapi.yaml. DO NOT EDIT.
// Run npm run generate:contracts.

export type { HttpPathParameters } from './types.ts'
export const API_VERSION = 1 as const
export const API_PREFIX = '/api/v1'
export const MAX_BODY_BYTES = 163840
export const httpOperations = {
  getMeta: {
    method: 'GET',
    path: '/meta',
    url: '/meta',
    request: null,
    successStatus: 200,
    responses: {
      '200': 'ServiceMeta',
      default: 'ApiError',
    },
  },
  listConversations: {
    method: 'GET',
    path: '/conversations',
    url: '/conversations',
    request: null,
    successStatus: 200,
    responses: {
      '200': 'Conversations',
      default: 'ApiError',
    },
  },
  createConversation: {
    method: 'POST',
    path: '/conversations',
    url: '/conversations',
    request: 'CreateConversationRequest',
    successStatus: 201,
    responses: {
      '201': 'Conversation',
      default: 'ApiError',
    },
  },
  getConversation: {
    method: 'GET',
    path: '/conversations/{id}',
    url: '/conversations/:id(^[A-Za-z0-9_-]+$)',
    request: null,
    successStatus: 200,
    responses: {
      '200': 'ConversationSnapshot',
      default: 'ApiError',
    },
  },
  renameConversation: {
    method: 'PATCH',
    path: '/conversations/{id}',
    url: '/conversations/:id(^[A-Za-z0-9_-]+$)',
    request: 'RenameConversationRequest',
    successStatus: 200,
    responses: {
      '200': 'Conversation',
      default: 'ApiError',
    },
  },
  deleteConversation: {
    method: 'DELETE',
    path: '/conversations/{id}',
    url: '/conversations/:id(^[A-Za-z0-9_-]+$)',
    request: null,
    successStatus: 204,
    responses: {
      '204': null,
      default: 'ApiError',
    },
  },
  selectConversationModel: {
    method: 'PUT',
    path: '/conversations/{id}/model',
    url: '/conversations/:id(^[A-Za-z0-9_-]+$)/model',
    request: 'ModelRef',
    successStatus: 200,
    responses: {
      '200': 'ConversationSnapshot',
      default: 'ApiError',
    },
  },
  startRun: {
    method: 'POST',
    path: '/conversations/{id}/runs',
    url: '/conversations/:id(^[A-Za-z0-9_-]+$)/runs',
    request: 'StartRunRequest',
    successStatus: 202,
    responses: {
      '202': 'Run',
      default: 'ApiError',
    },
  },
  streamRunEvents: {
    method: 'GET',
    path: '/runs/{id}/events',
    url: '/runs/:id(^[A-Za-z0-9_-]+$)/events',
    request: null,
    successStatus: 200,
    responses: {
      '200': null,
      default: 'ApiError',
    },
    eventSchema: 'RunEvent',
  },
  cancelRun: {
    method: 'POST',
    path: '/runs/{id}/cancel',
    url: '/runs/:id(^[A-Za-z0-9_-]+$)/cancel',
    request: null,
    successStatus: 200,
    responses: {
      '200': 'Run',
      default: 'ApiError',
    },
  },
  listModelAdapters: {
    method: 'GET',
    path: '/model-adapters',
    url: '/model-adapters',
    request: null,
    successStatus: 200,
    responses: {
      '200': 'ModelAdapters',
      default: 'ApiError',
    },
  },
  getProviders: {
    method: 'GET',
    path: '/model-providers',
    url: '/model-providers',
    request: null,
    successStatus: 200,
    responses: {
      '200': 'ProvidersState',
      default: 'ApiError',
    },
  },
  createProvider: {
    method: 'POST',
    path: '/model-providers',
    url: '/model-providers',
    request: 'CreateProviderRequest',
    successStatus: 201,
    responses: {
      '201': 'ProvidersState',
      default: 'ApiError',
    },
  },
  updateProvider: {
    method: 'PATCH',
    path: '/model-providers/{id}',
    url: '/model-providers/:id(^[A-Za-z0-9_-]+$)',
    request: 'SaveProviderRequest',
    successStatus: 200,
    responses: {
      '200': 'ProvidersState',
      default: 'ApiError',
    },
  },
  deleteProvider: {
    method: 'DELETE',
    path: '/model-providers/{id}',
    url: '/model-providers/:id(^[A-Za-z0-9_-]+$)',
    request: null,
    successStatus: 200,
    responses: {
      '200': 'ProvidersState',
      default: 'ApiError',
    },
  },
  listProviderModels: {
    method: 'GET',
    path: '/model-providers/{id}/models',
    url: '/model-providers/:id(^[A-Za-z0-9_-]+$)/models',
    request: null,
    successStatus: 200,
    responses: {
      '200': 'ModelDefinitions',
      default: 'ApiError',
    },
  },
  refreshProviderModels: {
    method: 'POST',
    path: '/model-providers/{id}/models/refresh',
    url: '/model-providers/:id(^[A-Za-z0-9_-]+$)/models/refresh',
    request: null,
    successStatus: 200,
    responses: {
      '200': 'ModelDefinitions',
      default: 'ApiError',
    },
  },
  testProvider: {
    method: 'POST',
    path: '/model-providers/{id}/test',
    url: '/model-providers/:id(^[A-Za-z0-9_-]+$)/test',
    request: 'ProviderTestRequest',
    successStatus: 204,
    responses: {
      '204': null,
      default: 'ApiError',
    },
  },
  selectDefaultModel: {
    method: 'PUT',
    path: '/model',
    url: '/model',
    request: 'ModelRef',
    successStatus: 200,
    responses: {
      '200': 'ProvidersState',
      default: 'ApiError',
    },
  },
  beginProviderLogin: {
    method: 'POST',
    path: '/model-providers/{id}/auth/attempts',
    url: '/model-providers/:id(^[A-Za-z0-9_-]+$)/auth/attempts',
    request: null,
    successStatus: 201,
    responses: {
      '201': 'ChatGPTLogin',
      default: 'ApiError',
    },
  },
  logoutProvider: {
    method: 'POST',
    path: '/model-providers/{id}/auth/logout',
    url: '/model-providers/:id(^[A-Za-z0-9_-]+$)/auth/logout',
    request: null,
    successStatus: 200,
    responses: {
      '200': 'LogoutResult',
      default: 'ApiError',
    },
  },
  getLoginAttempt: {
    method: 'GET',
    path: '/model-auth-attempts/{id}',
    url: '/model-auth-attempts/:id(^[A-Za-z0-9_-]+$)',
    request: null,
    successStatus: 200,
    responses: {
      '200': 'ChatGPTLogin',
      default: 'ApiError',
    },
  },
  cancelLoginAttempt: {
    method: 'POST',
    path: '/model-auth-attempts/{id}/cancel',
    url: '/model-auth-attempts/:id(^[A-Za-z0-9_-]+$)/cancel',
    request: null,
    successStatus: 204,
    responses: {
      '204': null,
      default: 'ApiError',
    },
  },
} as const
export const httpConstraints = {
  ModelRef: {
    modelId: {
      'x-utf16-maxLength': 200,
    },
  },
  ConversationSnapshot: {
    sequence: {
      minimum: 0,
      maximum: 9007199254740991,
    },
  },
  StartRunRequest: {
    message: {
      'x-utf16-maxLength': 32000,
    },
  },
  RenameConversationRequest: {
    title: {
      'x-trimmed-utf16-maxLength': 100,
    },
  },
  ModelDefinitionInput: {
    id: {
      'x-utf16-maxLength': 200,
    },
    name: {
      'x-utf16-maxLength': 200,
    },
    contextWindow: {
      minimum: 1,
      maximum: 10000000,
    },
    maxOutputTokens: {
      minimum: 1,
      maximum: 10000000,
    },
  },
  ConnectionConfigInput: {
    vendor: {
      'x-utf16-maxLength': 100,
    },
    name: {
      'x-utf16-maxLength': 100,
    },
    baseUrl: {
      'x-utf16-maxLength': 2000,
    },
  },
  ProviderTestRequest: {
    modelId: {
      'x-utf16-maxLength': 200,
    },
  },
} as const
