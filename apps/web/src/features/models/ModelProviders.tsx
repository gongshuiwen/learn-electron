import { useCallback, useEffect, useState } from 'react'
import {
  parseProvidersState,
  parseModels,
  parseModelAdapters,
  providerPresets,
  type ModelAdapterView,
  type ProvidersState,
  type EndpointInstanceView,
  type ModelDefinition,
  type SaveProviderRequest,
} from '@learn-electron/contracts/models'
import { Button } from '@/components/ui/button'
import { request } from '@/lib/api'
import { ChatGPTConnection } from '@/features/chatgpt/ChatGPTConnection'
import { useChatGPTConnection } from '@/features/chatgpt/use-chatgpt-connection'
import { ProviderForm } from './ProviderForm'

export function ModelProviders({
  onChanged,
  activeInstanceId,
  failureKey,
}: {
  onChanged: () => Promise<void>
  activeInstanceId: string | undefined
  failureKey: string | undefined
}) {
  const [state, setState] = useState<ProvidersState | null>(null)
  const [draft, setDraft] = useState<{ instanceId: string; modelId?: string } | null>(null)
  const [catalog, setCatalog] = useState<{ id: string; models: ModelDefinition[] } | null>(null)
  const [editing, setEditing] = useState<EndpointInstanceView | null | undefined>(undefined)
  const [initialPreset, setInitialPreset] = useState<'custom' | 'chatgpt'>('custom')
  const [operation, setOperation] = useState<
    'save' | 'default' | 'models' | 'test' | 'delete' | null
  >(null)
  const busy = operation !== null
  const [notice, setNotice] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [adapters, setAdapters] = useState<ModelAdapterView[]>([])
  const selection = state?.defaultSelection
  const currentConnectionId = selection?.instanceId
  const selectedId = draft?.instanceId ?? currentConnectionId ?? state?.instances[0]?.id
  const selected = state?.instances.find(({ id }) => id === selectedId)
  const account = selected?.kind === 'chatgpt' ? selected : null
  const accountId = account?.id
  const accountReady = account?.status === 'connected' && account.planUsage
  const pendingLoginId = state?.chatgpt.pendingLogin?.id
  const disabled = busy
  const selectedBusy = selectedId === activeInstanceId
  const models =
    selected?.kind === 'endpoint'
      ? selected.models
      : accountReady && catalog && catalog.id === selectedId
        ? catalog.models
        : []
  const wanted =
    draft?.modelId ??
    (selection && selection.instanceId === selectedId ? selection.modelId : undefined)
  const modelId = wanted
    ? models.some(({ id }) => id === wanted)
      ? wanted
      : ''
    : (models[0]?.id ?? '')
  const ready =
    selected?.kind === 'endpoint'
      ? selected.authentication === 'none' || selected.hasCredential
      : accountReady
  const using = Boolean(
    selection && selection.instanceId === selectedId && selection.modelId === modelId,
  )
  let modelHint = using
    ? '新会话使用此模型，已有对话保持原模型。'
    : '选择后点击“设为默认模型”；已有对话保持原模型。'
  if (!ready) {
    if (!account) modelHint = '请先编辑连接并补充 API Key，才能使用此连接。'
    else if (account.status === 'busy') modelHint = '账号正在更新，请稍后选择模型。'
    else if (account.status === 'connected')
      modelHint = '账号尚未获得 ChatGPT 计划使用权限，请检查账号或重新授权。'
    else modelHint = '请先完成 ChatGPT 授权，再选择模型。'
  } else if (!models.length) {
    modelHint =
      selected?.kind === 'endpoint'
        ? '暂无模型，请获取模型或编辑连接手动添加。'
        : '暂无模型，请点击“获取模型”重试。'
  } else if (!modelId) modelHint = '当前模型不可用，请重新选择。'

  const refresh = useCallback(
    (signal?: AbortSignal) =>
      request('/model-providers', parseProvidersState, signal ? { signal } : {}).then(
        async (next) => {
          if (signal?.aborted) return
          setState(next)
          await onChanged()
        },
      ),
    [onChanged],
  )

  const connected = useCallback((instanceId: string) => {
    setDraft({ instanceId })
    setDeleting(false)
  }, [])

  const loginConnected = useCallback(
    (instanceId: string) => {
      if (selectedId && selectedId !== instanceId) {
        setNotice('ChatGPT 登录成功，可在供应商列表中查看账号。')
        return
      }
      connected(instanceId)
      setNotice(
        currentConnectionId === instanceId
          ? '登录成功。'
          : '登录成功，可设为默认模型或返回聊天选择。',
      )
    },
    [connected, currentConnectionId, selectedId],
  )

  const loginCreated = useCallback(
    (providers: ProvidersState, instanceId: string) => {
      setState(providers)
      connected(instanceId)
      setEditing(undefined)
    },
    [connected],
  )

  const chatgpt = useChatGPTConnection({
    state: state?.chatgpt ?? null,
    onChanged: refresh,
    onCreated: loginCreated,
    onConnected: loginConnected,
  })

  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      refresh(controller.signal),
      request('/model-adapters', parseModelAdapters, { signal: controller.signal }).then(
        setAdapters,
      ),
    ]).catch(() => {
      if (!controller.signal.aborted) setNotice('无法读取模型连接，请稍后重试。')
    })
    return () => controller.abort()
  }, [refresh, failureKey])

  useEffect(() => {
    if (!accountId || !accountReady) return
    const controller = new AbortController()
    void request(`/model-providers/${accountId}/models`, parseModels, { signal: controller.signal })
      .then((models) => {
        if (!controller.signal.aborted) setCatalog({ id: accountId, models })
      })
      .catch(() => {
        if (!controller.signal.aborted) setNotice('模型目录暂不可用，请点击获取模型重试。')
      })
    return () => controller.abort()
  }, [accountId, accountReady, pendingLoginId, failureKey])

  async function act(
    action: 'default' | 'models' | 'test' | 'delete',
    run: () => Promise<unknown>,
  ): Promise<void> {
    setOperation(action)
    setNotice('')
    try {
      await run()
      await refresh().catch(() => setNotice('操作已完成，但状态刷新失败，请重新打开设置。'))
    } catch (error) {
      const refreshed = await refresh().then(
        () => true,
        () => false,
      )
      const message = error instanceof Error ? error.message : '模型连接操作失败。'
      setNotice(refreshed ? message : message + ' 状态刷新失败，请重新打开设置。')
    } finally {
      setOperation(null)
    }
  }

  async function save(body: SaveProviderRequest): Promise<void> {
    setOperation('save')
    try {
      const editingId = editing?.id
      const saved = await request(
        editingId ? `/model-providers/${editingId}` : '/model-providers',
        parseProvidersState,
        { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(body) },
      )
      const entry = editingId
        ? saved.instances.find(({ id }) => id === editingId)
        : saved.instances.find(
            (item) =>
              item.kind === 'endpoint' && !state?.instances.some(({ id }) => id === item.id),
          )
      setState(saved)
      if (entry) connected(entry.id)
      await onChanged().catch(() => setNotice('连接已保存，但聊天状态刷新失败，请重新打开设置。'))
    } finally {
      setOperation(null)
    }
  }

  return (
    <section className="model-connections" aria-label="模型设置">
      <header className="connection-heading">
        <div>
          <h2 className="text-lg font-semibold">模型供应商</h2>
          <p>管理供应商和账号，支持同一供应商的多个实例。</p>
        </div>
        <Button
          variant="outline"
          disabled={disabled || !state || !adapters.length}
          onClick={() => {
            chatgpt.setNotice(null)
            setInitialPreset('custom')
            setEditing(null)
          }}
        >
          添加提供商
        </Button>
      </header>
      {state ? (
        <p role="status" className="provider-default">
          {selection
            ? '新会话默认：' +
              (state.instances.find(({ id }) => id === selection.instanceId)?.name ??
                '实例不可用') +
              ' · ' +
              selection.modelId
            : '尚未设置默认模型。'}
        </p>
      ) : null}
      <div className={state?.instances.length ? 'provider-layout' : undefined}>
        <nav className="provider-list" aria-label="供应商实例">
          {!state ? <p role="status">{notice ? '无法读取供应商。' : '正在读取供应商…'}</p> : null}
          {state?.instances.length === 0 ? (
            <div className="provider-empty">
              <p>还没有供应商</p>
              <p>添加供应商或连接 ChatGPT 订阅，然后选择模型。</p>
            </div>
          ) : null}
          {state?.instances.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-label={'选择 ' + (entry.kind === 'chatgpt' ? 'ChatGPT · ' : '') + entry.name}
              aria-pressed={selectedId === entry.id}
              data-instance-id={entry.id}
              title={entry.name}
              disabled={disabled}
              onClick={() => {
                connected(entry.id)
                setNotice('')
              }}
            >
              <span className="flex min-w-0 items-center justify-between gap-2">
                <strong className="truncate">{entry.name}</strong>
                {selection?.instanceId === entry.id ? <small>默认</small> : null}
              </span>
              <span className="mt-1 block truncate text-xs text-stone-500 dark:text-stone-400">
                {entry.kind === 'chatgpt'
                  ? entry.status === 'authorizing'
                    ? 'ChatGPT · 授权中'
                    : entry.status === 'busy'
                      ? 'ChatGPT · 更新中'
                      : entry.status === 'connected' && entry.planUsage
                        ? 'ChatGPT · 已授权'
                        : 'ChatGPT · 待授权'
                  : entry.authentication === 'api-key' && !entry.hasCredential
                    ? '需要 API Key'
                    : (providerPresets.find(({ id }) => id === entry.vendor)?.name ?? entry.vendor)}
              </span>
            </button>
          ))}
        </nav>
        <div className="provider-detail">
          {selected ? (
            <section className="settings-section space-y-5" aria-label="供应商详情">
              <header className="flex flex-wrap items-start justify-between gap-3">
                <h3 className="text-base font-semibold break-all">{selected.name}</h3>
                <div className="flex flex-wrap gap-1">
                  {selected.kind === 'endpoint' ? (
                    <button
                      type="button"
                      className="provider-action"
                      disabled={disabled || selectedBusy}
                      onClick={() => setEditing(selected)}
                    >
                      编辑连接
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="provider-action"
                    disabled={
                      disabled ||
                      selectedBusy ||
                      (selected.kind === 'chatgpt' &&
                        selected.status !== 'signed_out' &&
                        selected.status !== 'reauth_required')
                    }
                    onClick={() => setDeleting(true)}
                  >
                    删除连接
                  </button>
                </div>
              </header>
              {account && state?.chatgpt.enabled ? (
                <ChatGPTConnection
                  selected={account}
                  blocked={busy}
                  connection={chatgpt}
                  onAdd={() => {
                    chatgpt.setNotice(null)
                    setInitialPreset('chatgpt')
                    setEditing(null)
                  }}
                />
              ) : null}
              {selected.kind === 'endpoint' ? (
                <dl className="provider-info">
                  <div>
                    <dt>接口协议</dt>
                    <dd>
                      {adapters.find(({ id }) => id === selected.protocol)?.name ??
                        selected.protocol}
                    </dd>
                  </div>
                  <div>
                    <dt>API 地址</dt>
                    <dd className="break-all">{selected.baseUrl}</dd>
                  </div>
                  <div>
                    <dt>认证</dt>
                    <dd>
                      {selected.authentication === 'none'
                        ? '无需 API Key'
                        : selected.hasCredential
                          ? 'API Key 已保存'
                          : '缺少 API Key，请编辑连接补充'}
                    </dd>
                  </div>
                </dl>
              ) : null}
              {selectedBusy ? (
                <p className="text-xs leading-6 text-stone-500 dark:text-stone-400">
                  此连接正在生成，暂时不能编辑、删除、获取模型或测试。
                </p>
              ) : null}
              <div className="space-y-1">
                <label className="grid gap-2">
                  模型
                  <select
                    aria-label="当前模型"
                    aria-describedby="provider-model-hint"
                    value={modelId}
                    disabled={disabled || !models.length}
                    onChange={(event) =>
                      setDraft({ instanceId: selected.id, modelId: event.target.value })
                    }
                  >
                    {!modelId ? <option value="">请添加、获取或选择模型</option> : null}
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p
                  id="provider-model-hint"
                  className="text-xs leading-6 text-stone-500 dark:text-stone-400"
                >
                  {modelHint}
                </p>
              </div>
              <div className="connection-actions">
                <Button
                  disabled={disabled || !ready || !modelId || using}
                  onClick={() =>
                    void act('default', () =>
                      request('/model', parseProvidersState, {
                        method: 'PUT',
                        body: JSON.stringify({ instanceId: selected.id, modelId }),
                      }),
                    )
                  }
                >
                  {operation === 'default' ? '正在设置…' : using ? '已设为默认' : '设为默认模型'}
                </Button>
                <button
                  type="button"
                  disabled={disabled || selectedBusy || !ready}
                  className="provider-action"
                  onClick={() =>
                    void act('models', async () => {
                      const models = await request(
                        '/model-providers/' + selected.id + '/models/refresh',
                        parseModels,
                        { method: 'POST' },
                      )
                      setCatalog({ id: selected.id, models })
                      setNotice('模型列表已更新。')
                    })
                  }
                >
                  {operation === 'models' ? '正在获取…' : '获取模型'}
                </button>
                <button
                  type="button"
                  disabled={disabled || selectedBusy || !ready || !modelId}
                  className="provider-action"
                  onClick={() =>
                    void act('test', async () => {
                      await request('/model-providers/' + selected.id + '/test', undefined, {
                        method: 'POST',
                        body: JSON.stringify({ modelId }),
                      })
                      setNotice('连接测试成功。')
                    })
                  }
                >
                  {operation === 'test' ? '正在测试…' : '测试连接'}
                </button>
              </div>
              <p className="text-xs leading-6 text-stone-500 dark:text-stone-400">
                测试连接会发送简短请求，可能产生少量用量。
              </p>
              {notice ? (
                <p role="status" className="provider-notice">
                  {notice}
                </p>
              ) : null}
              {deleting ? (
                <div className="space-y-2 border-l-2 border-red-600 pl-3" role="alert">
                  <p>删除“{selected.name}”及其凭据？关联历史仍可查看。</p>
                  {selection?.instanceId === selected.id ? (
                    <p>删除后需要重新设置默认模型。</p>
                  ) : null}
                  <div className="flex gap-3">
                    <button
                      type="button"
                      disabled={disabled}
                      className="text-red-700 underline dark:text-red-300"
                      onClick={() =>
                        void act('delete', async () => {
                          await request('/model-providers/' + selected.id, parseProvidersState, {
                            method: 'DELETE',
                          })
                          setDraft(null)
                          setDeleting(false)
                        })
                      }
                    >
                      {operation === 'delete' ? '正在删除…' : '确认删除连接'}
                    </button>
                    <button type="button" disabled={disabled} onClick={() => setDeleting(false)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}
          {notice && !selected ? (
            <p role="status" className="provider-notice">
              {notice}
            </p>
          ) : null}
        </div>
      </div>
      {editing !== undefined ? (
        <ProviderForm
          connection={editing}
          adapters={adapters}
          busy={busy || chatgpt.busy || Boolean(editing && editing.id === activeInstanceId)}
          saving={operation === 'save'}
          initialPreset={initialPreset}
          chatgpt={{
            enabled: state?.chatgpt.enabled ?? false,
            pending: chatgpt.loginPending,
            notice: chatgpt.notice,
            onLogin: () => chatgpt.startLogin(),
          }}
          onSave={save}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </section>
  )
}
