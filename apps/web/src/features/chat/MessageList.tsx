import { memo, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message } from '@learn-electron/contracts'

const plugins = [remarkGfm]

const MessageCard = memo(function MessageCard({ message }: { message: Message }) {
  return (
    <article
      className={`message message-${message.role}`}
      aria-label={message.role === 'user' ? '你的消息' : '助手回复'}
    >
      <div className="message-author">
        {message.role === 'user' ? (
          '你'
        ) : (
          <>
            <span className="message-avatar">π</span>Pi
          </>
        )}
      </div>
      <div className="message-content">
        {message.role === 'assistant' ? (
          <div className="markdown">
            <ReactMarkdown
              remarkPlugins={plugins}
              skipHtml
              components={{
                a: ({ children, href }) => (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
            {message.status === 'streaming' ? (
              <span className="stream-cursor" aria-label="正在生成" />
            ) : null}
          </div>
        ) : (
          <p className="whitespace-pre-wrap">{message.content}</p>
        )}
      </div>
      {message.status === 'interrupted' ? (
        <p className="mt-2 text-xs text-stone-400">回复已停止</p>
      ) : null}
    </article>
  )
})

export function MessageList({ messages }: { messages: Message[] }) {
  const container = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => {
    const element = container.current
    if (element && follow.current) element.scrollTop = element.scrollHeight
  }, [messages])
  return (
    <div
      className="messages-scroll"
      ref={container}
      onScroll={() => {
        const element = container.current
        if (element)
          follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100
      }}
    >
      <div className="messages" role="log" aria-label="聊天消息" aria-live="off">
        {messages.map((message) => (
          <MessageCard key={message.id} message={message} />
        ))}
      </div>
    </div>
  )
}
