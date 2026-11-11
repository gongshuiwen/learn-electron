import type { ChatGPTInstanceView } from '@learn-electron/contracts/models'
import { CHATGPT_USAGE_URL } from '@learn-electron/contracts/native'
import { Button } from '@/components/ui/button'
import { platform } from '@/platform'
import type { useChatGPTConnection } from './use-chatgpt-connection'

export function ChatGPTConnection({
  selected,
  blocked,
  connection,
  onAdd,
}: {
  selected: ChatGPTInstanceView
  blocked: boolean
  connection: ReturnType<typeof useChatGPTConnection>
  onAdd: () => void
}) {
  const {
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
  } = connection
  const disabled =
    busy ||
    loginPending ||
    blocked ||
    selected.status === 'authorizing' ||
    selected.status === 'busy'
  return (
    <section
      className="space-y-4 border-b border-stone-200 pb-5 dark:border-stone-800"
      aria-label="ChatGPT 连接"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-semibold">ChatGPT 账号</h4>
        <button
          type="button"
          className="provider-action"
          onClick={() =>
            void platform
              .openChatGPTUrl(CHATGPT_USAGE_URL)
              .catch(() => setNotice('无法打开用量页面。'))
          }
        >
          管理用量
        </button>
      </div>
      <p role="status">
        {selected.status === 'authorizing'
          ? '请在系统浏览器中完成此账号的授权…'
          : selected.status === 'busy'
            ? '此账号正在更新，请稍后再试。'
            : selected.status === 'reauth_required'
              ? '授权已失效，请重新登录。'
              : selected.status === 'connected'
                ? selected.planUsage
                  ? '已授权 · 可使用 ChatGPT 计划'
                  : '已登录，尚未启用 ChatGPT 计划使用。'
                : '连接 ChatGPT，使用你的计划或可用额度。'}
      </p>
      {loginPending && selected.status !== 'authorizing' ? (
        <p role="status">已有 ChatGPT 授权进行中，请在系统浏览器中完成。</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={disabled} onClick={() => void startLogin(selected.id)}>
          重新授权 ChatGPT
        </Button>
        <button type="button" className="provider-action" disabled={disabled} onClick={onAdd}>
          添加账号
        </button>
        {selected.status === 'connected' ? (
          <button
            type="button"
            className="provider-action"
            disabled={busy || blocked}
            onClick={() => void logout(selected.id)}
          >
            退出登录
          </button>
        ) : null}
      </div>
      {selected.status === 'connected' ? (
        <p className="text-xs leading-6 text-stone-500 dark:text-stone-400">
          如需删除此连接，请先退出登录。
        </p>
      ) : null}
      {loginPending && currentLogin ? (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="provider-action"
            onClick={() =>
              void platform
                .openChatGPTUrl(currentLogin.authorizationUrl)
                .catch(() => setNotice('请允许浏览器打开登录页面。'))
            }
          >
            重新打开登录
          </button>
          <button type="button" className="provider-action" onClick={() => void cancelLogin()}>
            取消登录
          </button>
        </div>
      ) : null}
      {welcome === selected.id && selected.planUsage ? (
        <div className="space-y-2 rounded bg-teal-50 p-3 text-teal-900 dark:bg-teal-950 dark:text-teal-100">
          <p>已获得 ChatGPT 计划使用权限。你可以在 ChatGPT 设置中管理本应用的用量。</p>
          <button
            type="button"
            className="underline"
            onClick={() => {
              setWelcome(null)
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
    </section>
  )
}
