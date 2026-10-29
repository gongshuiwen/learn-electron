import { useState } from 'react'
import { Bell } from 'lucide-react'
import type { NotificationResult } from '../../../shared/ipc'
import { Button } from '@/components/ui/button'

export function NotificationExample() {
  const [status, setStatus] = useState<NotificationResult | 'idle' | 'sending' | 'error'>('idle')

  async function sendNotification(): Promise<void> {
    setStatus('sending')
    try {
      setStatus(
        await window.electronAPI.showNotification('系统通知', '这是一条示例通知，点击可返回应用。'),
      )
    } catch {
      setStatus('error')
    }
  }

  return (
    <section className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-stone-900">
      <p className="text-xs font-medium tracking-widest text-stone-400">04 / NOTIFICATION</p>
      <h2 className="mt-3 text-lg font-semibold">系统通知</h2>
      <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">
        发送一条系统通知，点击通知可返回当前窗口。
      </p>
      <Button
        variant="outline"
        className="mt-4 disabled:cursor-wait"
        disabled={status === 'sending'}
        onClick={() => void sendNotification()}
      >
        <Bell aria-hidden="true" />
        {status === 'sending' ? '正在发送…' : '发送系统通知'}
      </Button>
      {status === 'error' ? (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
          未能发送或确认通知，请检查系统通知设置后重试。
        </p>
      ) : null}
      <p role="status" className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        {status === 'sent' ? '通知已交给系统，展示方式由系统通知设置决定。' : null}
        {status === 'unsupported' ? '当前系统不支持通知。' : null}
      </p>
    </section>
  )
}
