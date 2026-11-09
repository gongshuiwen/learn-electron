import { useState } from 'react'
import {
  ArrowUp,
  Check,
  Circle,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ThemeSelect } from '@/components/ThemeSelect'
import { MessageList } from '@/features/chat/MessageList'
import { useChat } from '@/features/chat/use-chat'
import { platform } from '@/platform'
import { ChatGPTConnection } from '@/features/chatgpt/ChatGPTConnection'

export default function App() {
  const chat = useChat()
  const [draft, setDraft] = useState('')
  const [editingTitle, setEditingTitle] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const title = chat.snapshot?.conversation.title ?? '新的开始'
  const run = chat.snapshot?.run

  async function send(): Promise<void> {
    const message = draft.trim()
    if (await chat.send(message)) setDraft((current) => (current.trim() === message ? '' : current))
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="会话侧栏">
        <div className="brand">
          <span className="brand-mark">π</span>
          <div>
            <strong>Pi Chat</strong>
            <p>留一点空间，给好想法。</p>
          </div>
        </div>
        <Button
          className="w-full justify-start"
          onClick={() => {
            setEditingTitle(null)
            setConfirmDelete(false)
            void chat.createConversation()
          }}
          disabled={chat.pending || chat.loading}
        >
          <Plus aria-hidden="true" />
          新建对话
        </Button>
        <div className="sidebar-caption">
          最近对话 <span>{chat.conversations.length}</span>
        </div>
        <nav className="conversation-list" aria-label="对话列表">
          {chat.conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              disabled={chat.pending}
              aria-current={chat.selectedId === conversation.id ? 'page' : undefined}
              onClick={() => {
                setEditingTitle(null)
                setConfirmDelete(false)
                chat.selectConversation(conversation.id)
              }}
              className={`conversation-item ${chat.selectedId === conversation.id ? 'selected' : ''}`}
            >
              <MessageSquare className="size-4 shrink-0" aria-hidden="true" />
              <span>{conversation.title}</span>
            </button>
          ))}
          {!chat.loading && !chat.conversations.length ? (
            <p className="px-3 text-xs leading-6 text-stone-400">
              你的对话会保存在服务端，
              <br />
              下次回来可以接着聊。
            </p>
          ) : null}
        </nav>
        {chat.meta?.authMode === 'chatgpt' ? (
          <ChatGPTConnection
            onChanged={chat.refreshMeta}
            activeRun={chat.active}
            failureKey={run?.status === 'failed' ? run.id : undefined}
          />
        ) : null}
        <div className="sidebar-footer">
          <ThemeSelect />
          <p>
            <Circle className="size-2 fill-current" aria-hidden="true" />
            {platform.kind === 'desktop' ? '桌面端' : 'Web 端'}
          </p>
        </div>
      </aside>

      <main className="chat-panel">
        <header className="chat-header">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{title}</h1>
            <p className="mt-1 truncate text-xs text-stone-400">
              {chat.meta ? `${chat.meta.model.provider} / ${chat.meta.model.id}` : '正在连接服务…'}
            </p>
          </div>
          {chat.snapshot ? (
            <div className="flex gap-1">
              <button
                type="button"
                className="icon-button"
                aria-label="重命名对话"
                title="重命名对话"
                disabled={chat.pending}
                onClick={() => {
                  setEditingTitle(title)
                  setConfirmDelete(false)
                }}
              >
                <Pencil className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="删除对话"
                title="删除对话"
                disabled={chat.pending || chat.active}
                onClick={() => {
                  setConfirmDelete(true)
                  setEditingTitle(null)
                }}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </header>

        {editingTitle !== null ? (
          <form
            className="action-bar"
            onSubmit={(event) => {
              event.preventDefault()
              void chat.rename(editingTitle).then((success) => {
                if (success) setEditingTitle(null)
              })
            }}
          >
            <label className="sr-only" htmlFor="conversation-title">
              对话标题
            </label>
            <input
              id="conversation-title"
              autoFocus
              maxLength={100}
              value={editingTitle}
              onChange={(event) => setEditingTitle(event.currentTarget.value)}
              className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-transparent px-3 py-2 text-sm dark:border-stone-700"
            />
            <Button type="submit" disabled={chat.pending || !editingTitle.trim()}>
              <Check aria-hidden="true" />
              保存
            </Button>
            <button
              type="button"
              className="icon-button"
              aria-label="取消重命名"
              onClick={() => setEditingTitle(null)}
            >
              <X className="size-4" />
            </button>
          </form>
        ) : null}
        {confirmDelete ? (
          <div className="action-bar" role="alert">
            <p className="flex-1 text-sm">删除这段对话及其消息？</p>
            <Button
              variant="outline"
              disabled={chat.pending}
              onClick={() => setConfirmDelete(false)}
            >
              保留
            </Button>
            <Button
              disabled={chat.pending}
              onClick={() =>
                void chat.remove().then((success) => {
                  if (success) setConfirmDelete(false)
                })
              }
            >
              确认删除
            </Button>
          </div>
        ) : null}
        {chat.error ? (
          <div className="notice notice-error" role="alert">
            <span>{chat.error}</span>
            <button
              type="button"
              onClick={chat.retry}
              className="inline-flex items-center gap-1 font-medium"
            >
              <RefreshCw className="size-3" aria-hidden="true" />
              重试
            </button>
          </div>
        ) : null}
        {chat.meta && !chat.meta.configured ? (
          <div className="notice" role="status">
            {chat.meta.authMode === 'chatgpt'
              ? '请在侧栏连接 ChatGPT，授权使用计划并选择可用模型。'
              : '尚未配置模型。请在服务端设置模型及 API Key 环境变量后重启服务；浏览器无需填写密钥。'}
          </div>
        ) : null}
        {chat.active && chat.connection === 'reconnecting' ? (
          <div className="notice" role="status">
            <span>连接中断，正在自动重连。回复仍在服务端继续。</span>
            <button type="button" onClick={chat.reconnect}>
              立即重连
            </button>
          </div>
        ) : null}
        {run?.status === 'failed' ? (
          <div className="notice notice-error" role="alert">
            {run.error ?? '生成失败，请重试。'}
          </div>
        ) : null}
        {run?.status === 'interrupted' ? (
          <div className="notice" role="status">
            上次回复因服务中断而结束，已保留收到的内容。你可以继续发送消息。
          </div>
        ) : null}

        {chat.loading ? (
          <div className="empty-state" role="status">
            <span className="loading-dot" />
            正在载入对话…
          </div>
        ) : chat.snapshot?.messages.length ? (
          <MessageList messages={chat.snapshot.messages} />
        ) : (
          <div className="empty-state">
            <div className="welcome-mark">π</div>
            <p className="mb-2 text-xs uppercase tracking-[0.25em] text-teal-700 dark:text-teal-400">
              A little room to think
            </p>
            <h2 className="text-3xl font-semibold tracking-tight">今天，想聊些什么？</h2>
            <p className="mt-4 max-w-sm text-sm leading-7 text-stone-500 dark:text-stone-400">
              整理一个想法，理解一个问题，
              <br />
              或从一句简单的问候开始。
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-2">
              {['帮我梳理一个想法', '解释一个复杂概念', '一起制定学习计划'].map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="suggestion"
                  onClick={() => setDraft(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="composer-wrap">
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            <label className="sr-only" htmlFor="message">
              发送消息
            </label>
            <textarea
              id="message"
              rows={2}
              maxLength={32000}
              value={draft}
              placeholder={
                chat.meta?.configured === false
                  ? chat.meta.authMode === 'chatgpt'
                    ? '请先连接 ChatGPT 并选择模型…'
                    : '请先在服务端配置模型…'
                  : '写下你的问题…'
              }
              disabled={!chat.meta?.configured || chat.loading}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  if (!chat.active && !chat.pending) void send()
                }
              }}
            />
            <div className="composer-bottom">
              <span>
                {chat.active
                  ? run?.status === 'cancelling'
                    ? '正在停止…'
                    : '正在生成回复…'
                  : 'Enter 发送 · Shift + Enter 换行'}
              </span>
              {chat.active ? (
                <Button
                  variant="outline"
                  disabled={chat.pending || run?.status === 'cancelling'}
                  onClick={() => void chat.cancel()}
                >
                  <Square className="size-3 fill-current" aria-hidden="true" />
                  停止生成
                </Button>
              ) : (
                <Button
                  type="submit"
                  aria-label="发送消息"
                  disabled={!draft.trim() || chat.pending || chat.loading || !chat.meta?.configured}
                >
                  <ArrowUp aria-hidden="true" />
                  发送
                </Button>
              )}
            </div>
          </form>
          <p className="composer-hint">
            {chat.meta?.capabilities.tools
              ? '工具能力由服务端控制。'
              : '纯聊天模式 · 未启用文件与终端工具'}
          </p>
        </div>
      </main>
    </div>
  )
}
