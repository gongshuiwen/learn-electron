import { useCallback, useEffect, useState } from 'react'
import { parseServiceMeta } from '@learn-electron/contracts'
import {
  parseChatGPTLogin,
  parseChatGPTModels,
  parseChatGPTState,
  parseLogoutResult,
} from '@learn-electron/contracts/chatgpt'
import type { ChatGPTLogin, ChatGPTModel, ChatGPTState } from '@learn-electron/contracts/chatgpt'
import { CHATGPT_USAGE_URL } from '@learn-electron/contracts/native'
import { Button } from '@/components/ui/button'
import { ApiRequestError, request } from '@/lib/api'
import { platform } from '@/platform'

function ignoreMissingLogin(error: unknown): undefined {
  if (
    !(error instanceof ApiRequestError && error.status === 404 && error.code === 'login_not_found')
  )
    throw error
  return undefined
}

export function ChatGPTConnection({
  onChanged,
  activeRun,
  failureKey,
}: {
  onChanged: () => Promise<void>
  activeRun: boolean
  failureKey: string | undefined
}) {
  const [state, setState] = useState<ChatGPTState | null>(null)
  const [models, setModels] = useState<ChatGPTModel[]>([])
  const [login, setLogin] = useState<ChatGPTLogin | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [welcome, setWelcome] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const refresh = useCallback(
    (signal?: AbortSignal) => {
      return Promise.allSettled([
        request('/auth/chatgpt', parseChatGPTState, signal ? { signal } : {}),
        request('/models', parseChatGPTModels, signal ? { signal } : {}),
      ]).then(async (results) => {
        if (signal?.aborted) return
        const [account, catalog] = results
        if (account.status === 'fulfilled') {
          setState(account.value)
          const pending = account.value.pendingLogin
          if (pending) setLogin((current) => (current?.id === pending.id ? current : pending))
        } else throw account.reason
        if (catalog.status === 'fulfilled') setModels(catalog.value)
        else setNotice('模型目录暂不可用，请点击刷新模型重试。')
        await onChanged()
      })
    },
    [onChanged],
  )

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal).catch(() => {
      if (!controller.signal.aborted) setNotice('无法读取 ChatGPT 连接，请稍后重试。')
    })
    return () => controller.abort()
  }, [refresh, failureKey])

  const loginId = login?.id
  const loginPending = login?.status === 'pending'
  useEffect(() => {
    if (!loginId || !loginPending) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll(): Promise<void> {
      try {
        const result = await request(`/auth/chatgpt/logins/${loginId}`, parseChatGPTLogin, {
          signal: controller.signal,
        }).catch(ignoreMissingLogin)
        if (controller.signal.aborted) return
        if (result?.status !== 'pending') {
          await refresh(controller.signal)
          if (controller.signal.aborted) return
          setLogin((current) => (current?.id === loginId ? (result ?? null) : current))
          setNotice(
            result
              ? (result.error ?? (result.status === 'expired' ? '登录已超时，请重试。' : null))
              : '登录请求已失效，请重新登录。',
          )
          if (result?.status === 'completed') {
            try {
              setWelcome(localStorage.getItem('pi-chat.chatgpt.welcome.v1') !== 'seen')
            } catch {
              setWelcome(true)
            }
          }
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
  }, [loginId, loginPending, refresh])

  async function act(operation: () => Promise<void>): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      await operation()
      await refresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '连接操作失败，请重试。')
    } finally {
      setBusy(false)
    }
  }

  function startLogin(profileId?: string): Promise<void> {
    return act(async () => {
      const result = await request('/auth/chatgpt/login', parseChatGPTLogin, {
        method: 'POST',
        body: JSON.stringify(profileId ? { profileId } : {}),
      })
      setLogin(result)
      await platform.openChatGPTUrl(result.authorizationUrl)
    })
  }

  const selected = state?.profiles.find((profile) => profile.id === state.activeId)
  const disabled = busy || loginPending || activeRun
  return (
    <section
      className="chatgpt-connection mt-4 border-t border-stone-200 pt-3 text-xs dark:border-stone-700"
      aria-label="ChatGPT 连接"
    >
      <button
        type="button"
        className="chatgpt-toggle"
        aria-expanded={expanded}
        aria-controls="chatgpt-controls"
        onClick={() => setExpanded((value) => !value)}
      >
        ChatGPT 连接设置
      </button>
      <div
        id="chatgpt-controls"
        className={`chatgpt-controls space-y-3 ${expanded ? 'is-open' : ''}`}
      >
        <div className="flex items-center justify-between gap-2">
          <strong>ChatGPT</strong>
          <button
            type="button"
            className="text-teal-700 underline dark:text-teal-400"
            onClick={() =>
              void platform
                .openChatGPTUrl(CHATGPT_USAGE_URL)
                .catch(() => setNotice('无法打开用量页面。'))
            }
          >
            管理用量
          </button>
        </div>
        {state?.profiles.length ? (
          <label className="block space-y-1">
            <span>授权连接</span>
            <select
              className="w-full rounded border border-stone-300 bg-transparent p-2 dark:border-stone-600"
              aria-label="ChatGPT 授权连接"
              value={state.activeId ?? ''}
              disabled={disabled}
              onChange={(event) =>
                void act(async () => {
                  await request('/auth/chatgpt/select', parseChatGPTState, {
                    method: 'POST',
                    body: JSON.stringify({ profileId: event.target.value }),
                  })
                })
              }
            >
              {!state.activeId ? <option value="">选择连接</option> : null}
              {state.profiles.map((profile, index) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label} · {index + 1}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <p role="status">
          {loginPending
            ? '请在系统浏览器中完成授权…'
            : selected?.status === 'reauth_required'
              ? '授权已失效，请重新登录。'
              : selected?.status === 'connected'
                ? selected.planUsage
                  ? '已连接 · 使用 ChatGPT 计划'
                  : '已登录，尚未启用 ChatGPT 计划使用。'
                : '连接 ChatGPT，使用你的计划或可用额度。'}
        </p>
        {selected?.planUsage ? (
          <label className="block space-y-1">
            <span>模型</span>
            <select
              aria-label="ChatGPT 模型"
              className="w-full rounded border border-stone-300 bg-transparent p-2 dark:border-stone-600"
              disabled={disabled || !models.length}
              value={selected.modelId ?? ''}
              onChange={(event) =>
                void act(async () => {
                  await request('/model', parseServiceMeta, {
                    method: 'PUT',
                    body: JSON.stringify({ modelId: event.target.value }),
                  })
                })
              }
            >
              {!models.some((model) => model.id === selected.modelId) ? (
                <option value={selected.modelId ?? ''}>请选择可用模型</option>
              ) : null}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={disabled}
              className="underline"
              onClick={() =>
                void act(async () => {
                  setModels(await request('/models?refresh=1', parseChatGPTModels))
                })
              }
            >
              刷新模型
            </button>
          </label>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => void startLogin(selected?.id)}
          >
            {selected ? '重新授权 ChatGPT' : 'Continue with ChatGPT'}
          </Button>
          {selected ? (
            <button
              type="button"
              className="underline"
              disabled={disabled}
              onClick={() => void startLogin()}
            >
              添加连接
            </button>
          ) : null}
          {selected?.status === 'connected' ? (
            <button
              type="button"
              className="underline"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const result = await request('/auth/chatgpt/logout', parseLogoutResult, {
                    method: 'POST',
                  })
                  setLogin(null)
                  if (!result.revoked)
                    setNotice('已退出本地连接；远程撤销尚未确认，可在 ChatGPT 设置中断开应用。')
                })
              }
            >
              退出登录
            </button>
          ) : null}
        </div>
        {loginPending && login ? (
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="underline"
              onClick={() =>
                void platform
                  .openChatGPTUrl(login.authorizationUrl)
                  .catch(() => setNotice('请允许浏览器打开登录页面。'))
              }
            >
              重新打开登录
            </button>
            <button
              type="button"
              className="underline"
              onClick={() =>
                void act(async () => {
                  await request(`/auth/chatgpt/logins/${login.id}`, undefined, {
                    method: 'DELETE',
                  }).catch(ignoreMissingLogin)
                  setLogin(null)
                })
              }
            >
              取消登录
            </button>
          </div>
        ) : null}
        {welcome && selected?.planUsage ? (
          <div className="space-y-2 rounded bg-teal-50 p-3 text-teal-900 dark:bg-teal-950 dark:text-teal-100">
            <p>正在使用你的 ChatGPT 计划。你可以在 ChatGPT 设置中管理本应用的用量。</p>
            <button
              type="button"
              className="underline"
              onClick={() => {
                setWelcome(false)
                try {
                  localStorage.setItem('pi-chat.chatgpt.welcome.v1', 'seen')
                } catch {
                  /* Optional display preference. */
                }
              }}
            >
              知道了
            </button>
          </div>
        ) : null}
        {notice ? (
          <p role="alert" className="text-amber-800 dark:text-amber-300">
            {notice}
          </p>
        ) : null}
      </div>
    </section>
  )
}
