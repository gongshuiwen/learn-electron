import { queryOptions } from '@tanstack/react-query'
import {
  parseModelAdapters,
  parseModels,
  parseProvidersState,
} from '@learn-electron/contracts/models'
import { request } from '@/lib/api'

export const modelQueryKey = ['models'] as const

export const providersQuery = queryOptions({
  queryKey: [...modelQueryKey, 'providers'],
  queryFn: ({ signal }) => request('/model-providers', parseProvidersState, { signal }),
})

export const adaptersQuery = queryOptions({
  queryKey: [...modelQueryKey, 'adapters'],
  queryFn: ({ signal }) => request('/model-adapters', parseModelAdapters, { signal }),
  staleTime: Infinity,
})

export const providerModelsQuery = (instanceId: string) =>
  queryOptions({
    queryKey: [...modelQueryKey, 'catalog', instanceId],
    queryFn: ({ signal }) =>
      request(`/model-providers/${encodeURIComponent(instanceId)}/models`, parseModels, { signal }),
  })
