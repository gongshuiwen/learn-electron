import { useEffect, useState } from 'react'
import {
  parseChatGPTLogin,
  parseLogoutResult,
  type ChatGPTLogin,
} from '@learn-electron/contracts/chatgpt'
import { parseProvidersState, type ProvidersState } from '@learn-electron/contracts/models'
import { ApiRequestError, request } from '@/lib/api'
import { platform } from '@/platform'

function ignoreMissingLogin(error: unknown): undefined {
  if (
    !(error instanceof ApiRequestError && error.status === 404 && error.code === 'login_not_found')
  )
    throw error
  return undefined
}

export function useChatGPTConnection({
  state,
  onChanged,
  onCreated,
  onConnected,
}: {
  state: ProvidersState['chatgpt'] | null
  onChanged: (signal?: AbortSignal) => Promise<void>
  onCreated: (providers: ProvidersState, instanceId: string) => void
  onConnected: (instanceId: string) => void
}) {
  const [login, setLogin] = useState<ChatGPTLogin | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [welcome, setWelcome] = useState<string | null>(null)
  const currentLogin = state?.pendingLogin ?? login
  const loginId = currentLogin?.id
  const loginPending = currentLogin?.status === 'pending'

  useEffect(() => {
    if (!loginId || !loginPending) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll(): Promise<void> {
      try {
        const result = await request(`/model-auth-attempts/${loginId}`, parseChatGPTLogin, {
          signal: controller.signal,
        }).catch(ignoreMissingLogin)
        if (controller.signal.aborted) return
        if (result?.status !== 'pending') {
          setLogin((current) => (!current || current.id === loginId ? (result ?? null) : current))
          setNotice(
            result
              ? (result.error ?? (result.status === 'expired' ? '登录已超时，请重试。' : null))
              : '登录请求已失效，请重新登录。',
          )
          if (result?.status === 'completed') {
            onConnected(result.instanceId)
            try {
              setWelcome(
                localStorage.getItem('pi-chat.chatgpt.welcome.v1') !== 'seen'
                  ? result.instanceId
                  : null,
              )
            } catch {
              setWelcome(result.instanceId)
            }
          }
          await onChanged(controller.signal).catch(() => {
            if (!controller.signal.aborted) setNotice('连接状态刷新失败，请重新打开设置。')
          })
        } else timer = setTimeout(() => void poll(), 800)
      } catch {
        if (!controller.signal.aborted) {
          setNotice('登录状态暂不可用，正在重新连接…')
          timer = setTimeout(() => void poll(), 1500)
        }
      }
    }
    timer = setTimeout(() => void poll(), 500)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [loginId, loginPending, onChanged, onConnected])

  async function act(operation: () => Promise<void>): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      await operation()
      await onChanged().catch(() => setNotice('操作已完成，但状态刷新失败，请重新打开设置。'))
    } catch (error) {
      const refreshed = await onChanged().then(
        () => true,
        () => false,
      )
      const message = error instanceof Error ? error.message : '连接操作失败，请重试。'
      setNotice(refreshed ? message : message + ' 状态刷新失败，请重新打开设置。')
    } finally {
      setBusy(false)
    }
  }

  function startLogin(instanceId?: string): Promise<void> {
    return act(async () => {
      if (!instanceId) {
        const providers = await request('/model-providers', parseProvidersState, {
          method: 'POST',
          body: JSON.stringify({ kind: 'chatgpt' }),
        })
        instanceId = providers.instances.at(-1)!.id
        onCreated(providers, instanceId)
      }
      const result = await request(
        `/model-providers/${instanceId}/auth/attempts`,
        parseChatGPTLogin,
        { method: 'POST' },
      )
      setLogin(result)
      await platform.openChatGPTUrl(result.authorizationUrl)
    })
  }

  function cancelLogin(): Promise<void> {
    if (!currentLogin) return Promise.resolve()
    return act(async () => {
      await request(`/model-auth-attempts/${currentLogin.id}/cancel`, undefined, {
        method: 'POST',
      }).catch(ignoreMissingLogin)
      setLogin(null)
    })
  }

  function logout(instanceId: string): Promise<void> {
    return act(async () => {
      const result = await request(
        `/model-providers/${instanceId}/auth/logout`,
        parseLogoutResult,
        { method: 'POST' },
      )
      setLogin(null)
      if (!result.revoked)
        setNotice('已退出本地连接；远程撤销尚未确认，可在 ChatGPT 设置中断开应用。')
    })
  }

  return {
    busy,
    notice,
    setNotice,
    welcome,
    setWelcome,
    currentLogin,
    loginPending,
    startLogin,
    cancelLogin,
    logout,
  }
}
