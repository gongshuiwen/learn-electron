import { useState } from 'react'
import { Copy } from 'lucide-react'
import type { AppInfo } from '../../../shared/ipc'
import { Button } from '@/components/ui/button'

interface RuntimeInfoProps {
  info: AppInfo
}

export function RuntimeInfo({ info }: RuntimeInfoProps) {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const entries = [
    ['应用', `${info.name} ${info.version}`],
    ['Electron', info.electron],
    ['Chromium', info.chrome],
    ['Node.js', info.node],
    ['系统', info.os],
    ['架构', info.arch],
  ]

  async function copyDiagnostics(): Promise<void> {
    setStatus('copying')
    try {
      await window.electronAPI.copyDiagnostics()
      setStatus('copied')
    } catch {
      setStatus('error')
    }
  }

  return (
    <div>
      <dl className="space-y-2 border-t border-stone-100 dark:border-stone-800 pt-4 text-xs">
        {entries.map(([label, value]) => (
          <div key={label} className="flex flex-wrap justify-between gap-2">
            <dt className="text-stone-500 dark:text-stone-400">{label}</dt>
            <dd className="font-mono text-stone-700 dark:text-stone-300">{value}</dd>
          </div>
        ))}
      </dl>
      <Button
        variant="outline"
        className="mt-4 disabled:cursor-wait"
        disabled={status === 'copying'}
        onClick={() => void copyDiagnostics()}
      >
        <Copy aria-hidden="true" />
        {status === 'copying' ? '正在复制…' : '复制诊断信息'}
      </Button>
      {status === 'error' ? (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
          复制失败，请重试。
        </p>
      ) : null}
      <p role="status" className="mt-2 text-sm text-stone-500 dark:text-stone-400">
        {status === 'copied' ? '已复制诊断信息。' : null}
      </p>
    </div>
  )
}
