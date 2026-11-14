import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { type ModelStatus, type ModelRef } from '@learn-electron/contracts/models'
import { Button } from '@/components/ui/button'
import { providerModelsQuery, providersQuery } from './queries'

type ModelPickerProps = {
  model: ModelStatus | null
  disabled: boolean
  hasHistory: boolean
  onSelect: (selection: ModelRef) => Promise<boolean>
}

export function ModelPicker(props: ModelPickerProps) {
  const { model, disabled } = props
  const details = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)
  const label = model?.target ? `${model.model.provider} / ${model.model.id}` : '选择模型'

  function close(): void {
    if (details.current) details.current.open = false
  }

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !details.current?.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])

  return (
    <details
      ref={details}
      className="model-picker"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          close()
          details.current?.querySelector('summary')?.focus()
        }
      }}
    >
      <summary
        role="button"
        aria-label="选择聊天模型"
        aria-expanded={open}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        title={label}
        onClick={(event) => {
          if (disabled) event.preventDefault()
        }}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
      </summary>
      {open ? <ModelPickerPanel {...props} onClose={close} /> : null}
    </details>
  )
}

function ModelPickerPanel({
  model,
  disabled,
  hasHistory,
  onSelect,
  onClose,
}: ModelPickerProps & { onClose: () => void }) {
  const [instanceId, setInstanceId] = useState(model?.target?.instanceId ?? '')
  const [wanted, setWanted] = useState<string | null>(model?.target?.modelId ?? null)
  const providersResult = useQuery(providersQuery)
  const providers = providersResult.isError ? null : providersResult.data
  const instance = providers?.instances.find(({ id }) => id === instanceId)
  const ready =
    instance?.kind === 'endpoint'
      ? instance.authentication === 'none' || instance.hasCredential
      : instance?.status === 'connected' && instance.planUsage
  const accountId = instance?.kind === 'chatgpt' && ready ? instance.id : undefined
  const catalog = useQuery({
    ...providerModelsQuery(accountId ?? ''),
    enabled: Boolean(accountId),
  })
  const models =
    instance?.kind === 'endpoint' ? instance.models : catalog.isError ? [] : (catalog.data ?? [])
  const modelId = wanted
    ? models.some(({ id }) => id === wanted)
      ? wanted
      : ''
    : (models[0]?.id ?? '')
  const unchanged = instanceId === model?.target?.instanceId && modelId === model.target.modelId

  return (
    <div className="model-picker-panel" role="dialog" aria-label="聊天模型选择">
      <header className="flex items-center justify-between gap-3">
        <strong>选择模型</strong>
        <a href="#/settings" onClick={onClose}>
          管理模型
        </a>
      </header>
      <p>
        {hasHistory ? '切换会新建对话，原对话和草稿保留。' : '仅用于当前对话，不修改默认模型。'}
      </p>
      {providersResult.isLoading ? (
        <p role="status">正在读取模型…</p>
      ) : providers ? (
        <>
          <label>
            供应商实例
            <select
              aria-label="供应商实例"
              value={instanceId}
              disabled={disabled}
              onChange={(event) => {
                setInstanceId(event.target.value)
                setWanted(null)
              }}
            >
              <option value="" disabled>
                请选择供应商实例
              </option>
              {providers.instances.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.kind === 'chatgpt' ? `ChatGPT · ${entry.name}` : entry.name}
                </option>
              ))}
            </select>
          </label>
          {instance ? (
            <label>
              模型
              <select
                aria-label="聊天模型"
                value={modelId}
                disabled={disabled || !ready || !models.length}
                onChange={(event) => setWanted(event.target.value)}
              >
                {!modelId ? <option value="">请选择可用模型</option> : null}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {!providers.instances.length ? (
            <p role="status">暂无可用配置，请先在设置中添加提供商或登录 ChatGPT。</p>
          ) : instance && !ready ? (
            <p role="status">
              {instance.kind === 'chatgpt' && instance.status === 'authorizing'
                ? '该账号正在授权，请完成或取消登录。'
                : instance.kind === 'chatgpt' && instance.status === 'busy'
                  ? '该账号正在更新，请稍后再试。'
                  : '该实例尚未授权，请前往设置更新凭据。'}
            </p>
          ) : accountId && catalog.isPending ? (
            <p role="status">正在读取模型目录…</p>
          ) : instance && !models.length ? (
            <p role="status">
              {catalog.error
                ? '无法读取模型目录，请重试或前往设置。'
                : '暂无模型，请前往设置添加或获取模型。'}
            </p>
          ) : null}
          <Button
            type="button"
            className="w-full"
            disabled={disabled || !ready || !modelId || unchanged}
            onClick={() => {
              if (instance && modelId)
                void onSelect({ instanceId: instance.id, modelId }).then((success) => {
                  if (success) onClose()
                })
            }}
          >
            {hasHistory ? '使用并新建对话' : '使用此模型'}
          </Button>
        </>
      ) : null}
      {providersResult.error ? (
        <div role="alert">
          <p>{providersResult.error.message}</p>
          <button type="button" onClick={() => void providersResult.refetch()}>
            重试
          </button>
        </div>
      ) : null}
    </div>
  )
}
