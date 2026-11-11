import { useEffect, useRef } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { ServiceMeta } from '@learn-electron/contracts'
import { Button } from '@/components/ui/button'
import { ModelProviders } from '@/features/models/ModelProviders'

export function SettingsPage({
  engine,
  error,
  onRetry,
  onChanged,
  activeRun,
  activeInstanceId,
  failureKey,
}: {
  engine: ServiceMeta['engine'] | undefined
  error: string | null
  onRetry: () => void
  onChanged: () => Promise<void>
  activeRun: boolean
  activeInstanceId: string | undefined
  failureKey: string | undefined
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])

  return (
    <main className="settings-page" aria-labelledby="settings-title">
      <header className="settings-header">
        <div>
          <h1 id="settings-title" ref={heading} tabIndex={-1}>
            设置
          </h1>
          <p>管理模型与账号。</p>
        </div>
        <a href="#/" className="back-to-chat">
          <ArrowLeft className="size-4" aria-hidden="true" />
          返回聊天
        </a>
      </header>
      <div className="settings-scroll">
        <div className="settings-content">
          {activeRun && engine === 'pi' ? (
            <p role="status" className="mb-6 text-sm leading-6 text-stone-500 dark:text-stone-400">
              回复仍在后台生成。可更改新会话的默认模型；修改正在使用的实例需先停止生成。
            </p>
          ) : null}
          {engine === 'pi' ? (
            <ModelProviders
              onChanged={onChanged}
              activeInstanceId={activeInstanceId}
              failureKey={failureKey}
            />
          ) : (
            <section className="settings-section space-y-4" aria-label="模型设置">
              <h2>模型连接</h2>
              {error && !engine ? (
                <>
                  <p role="alert">{error}</p>
                  <Button variant="outline" onClick={onRetry}>
                    重试
                  </Button>
                </>
              ) : (
                <p role="status">
                  {engine === 'mock'
                    ? '当前为演示模式，使用模拟回复，无需配置模型连接。'
                    : '正在读取服务信息…'}
                </p>
              )}
            </section>
          )}
        </div>
      </div>
    </main>
  )
}
