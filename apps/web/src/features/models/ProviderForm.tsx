import { useEffect, useRef, useState } from 'react'
import { httpConstraints } from '@learn-electron/contracts/http'
import {
  providerPresets,
  parseCredentialHeaders,
  type EndpointInstanceView,
  type Protocol,
  type ModelAdapterView,
  type SaveProviderRequest,
} from '@learn-electron/contracts/models'
import { Button } from '@/components/ui/button'

export function ProviderForm({
  connection,
  adapters,
  busy,
  saving,
  initialPreset,
  chatgpt,
  onSave,
  onClose,
}: {
  connection: EndpointInstanceView | null
  adapters: ModelAdapterView[]
  busy: boolean
  saving: boolean
  initialPreset: 'custom' | 'chatgpt'
  chatgpt: {
    enabled: boolean
    pending: boolean
    notice: string | null
    onLogin: () => Promise<void>
  }
  onSave: (request: SaveProviderRequest) => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [presetId, setPresetId] = useState<string>(initialPreset)
  const [startingLogin, setStartingLogin] = useState(false)
  const [endpointPreset, setEndpointPreset] = useState('custom')
  const [vendor, setVendor] = useState(connection?.vendor ?? 'custom')
  const [name, setName] = useState(connection?.name ?? '')
  const [protocol, setProtocol] = useState<Protocol>(connection?.protocol ?? 'openai-chat')
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '')
  const [authentication, setAuthentication] = useState<SaveProviderRequest['authentication']>(
    connection?.authentication ?? 'api-key',
  )
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [headers, setHeaders] = useState('')
  const [modelIds, setModelIds] = useState(connection?.models.map(({ id }) => id).join('\n') ?? '')
  const [contextWindow, setContextWindow] = useState(connection?.models[0]?.contextWindow ?? 32768)
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    connection?.models[0]?.maxOutputTokens ?? 4096,
  )
  const [compatibility, setCompatibility] = useState(connection?.compatibility ?? {})
  const [error, setError] = useState('')
  const submitting = saving || startingLogin

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  async function save(): Promise<void> {
    setError('')
    try {
      const value = headers.trim()
        ? parseCredentialHeaders(JSON.parse(headers) as unknown)
        : undefined
      const limitsChanged =
        contextWindow !== (connection?.models[0]?.contextWindow ?? 32768) ||
        maxOutputTokens !== (connection?.models[0]?.maxOutputTokens ?? 4096)
      await onSave({
        name,
        vendor,
        protocol,
        baseUrl,
        authentication,
        models: modelIds
          .split('\n')
          .map((id) => id.trim())
          .filter(Boolean)
          .map((id) => {
            const existing = connection?.models.find((model) => model.id === id)
            return existing && !limitsChanged
              ? existing
              : { id, name: existing?.name ?? id, contextWindow, maxOutputTokens }
          }),
        compatibility: protocol === 'openai-chat' ? compatibility : {},
        ...(clearKey ? { apiKey: null } : apiKey ? { apiKey } : {}),
        ...(value !== undefined ? { headers: value } : {}),
      })
      setApiKey('')
      setHeaders('')
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存失败，请重试。')
    }
  }

  return (
    <dialog
      ref={dialog}
      className="connection-dialog"
      aria-labelledby="connection-form-title"
      onCancel={(event) => {
        if (submitting) event.preventDefault()
        else onClose()
      }}
    >
      <form
        className="connection-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (presetId !== 'chatgpt' || connection) void save()
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="connection-form-title">{connection ? '编辑供应商实例' : '添加模型提供商'}</h2>
            <p>
              {!connection && presetId === 'chatgpt'
                ? '登录后可以选择模型，凭据由当前服务保管。'
                : '保存后即时生效，凭据由当前服务保管。'}
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭模型设置"
            disabled={submitting}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <fieldset disabled={busy} className="grid gap-4">
          {!connection ? (
            <label>
              提供商预设
              <select
                aria-label="提供商预设"
                value={presetId}
                onChange={(event) => {
                  const id = event.target.value
                  setPresetId(id)
                  if (id === 'chatgpt' || id === endpointPreset) return
                  const preset = providerPresets.find((item) => item.id === id)!
                  setEndpointPreset(id)
                  setVendor(preset.id)
                  setName(preset.id === 'custom' ? '' : preset.name)
                  setProtocol(preset.protocol)
                  setBaseUrl(preset.baseUrl)
                  setAuthentication(preset.authentication)
                  setCompatibility({})
                }}
              >
                <option value="chatgpt">ChatGPT 订阅</option>
                {providerPresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {!connection && presetId === 'chatgpt' ? (
            <div className="space-y-2">
              <p>通过系统浏览器授权 ChatGPT 账号，可用模型取决于账号的计划权限。</p>
              <p>使用 OpenAI API Key 时，请选择 OpenAI 预设。</p>
              {!chatgpt.enabled ? <p role="status">当前运行模式不支持 ChatGPT 登录。</p> : null}
              {chatgpt.pending ? (
                <p role="status">已有 ChatGPT 授权进行中，请在对应账号中完成或取消。</p>
              ) : null}
            </div>
          ) : (
            <>
              <label>
                实例名称
                <input
                  required
                  maxLength={httpConstraints.ConnectionConfigInput.name['x-utf16-maxLength']}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：我的 DeepSeek"
                />
              </label>
              <div className="connection-columns">
                <label>
                  接口协议
                  <select
                    aria-label="接口协议"
                    value={protocol}
                    disabled={Boolean(connection)}
                    onChange={(event) => {
                      const value = event.target.value as Protocol
                      setProtocol(value)
                      setCompatibility({})
                      const methods = adapters.find(({ id }) => id === value)!.authentication
                      if (!methods.includes(authentication)) setAuthentication(methods[0]!)
                    }}
                  >
                    {adapters.map((adapter) => (
                      <option key={adapter.id} value={adapter.id}>
                        {adapter.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  认证方式
                  <select
                    aria-label="认证方式"
                    value={authentication}
                    onChange={(event) =>
                      setAuthentication(event.target.value as SaveProviderRequest['authentication'])
                    }
                  >
                    <option value="api-key">API Key</option>
                    {adapters.find(({ id }) => id === protocol)?.authentication.includes('none') ? (
                      <option value="none">无需认证 / 自定义请求头</option>
                    ) : null}
                  </select>
                </label>
              </div>
              <label>
                API 地址
                <input
                  aria-label="API 地址"
                  type="url"
                  required
                  readOnly={Boolean(connection)}
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://gateway.example.com/v1"
                />
                <small>填写 API 基地址，保留服务要求的版本路径。更换地址或协议请新建实例。</small>
              </label>
              {authentication === 'api-key' ? (
                <label>
                  API Key
                  <input
                    aria-label="API Key"
                    type="password"
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value)
                      setClearKey(false)
                    }}
                    placeholder={
                      connection?.hasCredential ? '已保存，留空保持不变' : '填写提供商的密钥'
                    }
                  />
                  {connection?.hasCredential ? (
                    <span className="connection-checkbox">
                      <input
                        type="checkbox"
                        checked={clearKey}
                        onChange={(event) => {
                          setClearKey(event.target.checked)
                          setApiKey('')
                        }}
                      />
                      清除已保存密钥
                    </span>
                  ) : null}
                </label>
              ) : null}
              <label>
                模型 ID
                <textarea
                  aria-label="模型 ID"
                  rows={3}
                  value={modelIds}
                  onChange={(event) => setModelIds(event.target.value)}
                  placeholder={'每行一个模型 ID\n也可以保存后获取模型列表'}
                />
                <small>无需等待模型目录更新，可以直接填写服务提供的模型 ID。</small>
              </label>
              <details>
                <summary>高级设置</summary>
                <div className="mt-4 grid gap-4">
                  <label>
                    供应商品牌
                    <input
                      value={vendor}
                      required
                      maxLength={httpConstraints.ConnectionConfigInput.vendor['x-utf16-maxLength']}
                      onChange={(event) => setVendor(event.target.value)}
                      placeholder="例如：openai、deepseek 或内部网关"
                    />
                  </label>
                  <div className="connection-columns">
                    <label>
                      上下文长度
                      <input
                        type="number"
                        min={httpConstraints.ModelDefinitionInput.contextWindow.minimum}
                        max={httpConstraints.ModelDefinitionInput.contextWindow.maximum}
                        required
                        value={contextWindow}
                        onChange={(event) => setContextWindow(event.target.valueAsNumber)}
                      />
                    </label>
                    <label>
                      最大输出长度
                      <input
                        type="number"
                        min={httpConstraints.ModelDefinitionInput.maxOutputTokens.minimum}
                        max={Math.min(
                          contextWindow,
                          httpConstraints.ModelDefinitionInput.maxOutputTokens.maximum,
                        )}
                        required
                        value={maxOutputTokens}
                        onChange={(event) => setMaxOutputTokens(event.target.valueAsNumber)}
                      />
                    </label>
                  </div>
                  <small>
                    新模型使用这些长度；修改长度会应用于所填模型，其余保留已有设置。请按服务规格调整。
                  </small>
                  <label>
                    自定义请求头
                    <textarea
                      aria-label="自定义请求头"
                      rows={3}
                      value={headers}
                      onChange={(event) => setHeaders(event.target.value)}
                      placeholder={
                        connection?.hasHeaders
                          ? '已有请求头，留空保持；填写 {} 清除'
                          : '{"X-Gateway-Key": "…"}'
                      }
                    />
                    <small>按原文发送并作为凭据保存，读取配置时不回显。</small>
                  </label>
                  {protocol === 'openai-chat' ? (
                    <>
                      <label>
                        输出长度参数
                        <select
                          value={compatibility.maxTokensField ?? ''}
                          onChange={(event) => {
                            const next = { ...compatibility }
                            if (event.target.value)
                              next.maxTokensField = event.target.value as
                                | 'max_tokens'
                                | 'max_completion_tokens'
                            else delete next.maxTokensField
                            setCompatibility(next)
                          }}
                        >
                          <option value="">自动</option>
                          <option value="max_tokens">max_tokens</option>
                          <option value="max_completion_tokens">max_completion_tokens</option>
                        </select>
                      </label>
                      {(
                        [
                          ['supportsDeveloperRole', '使用 system 角色'],
                          ['supportsUsageInStreaming', '禁用流式用量字段'],
                          ['supportsStore', '不发送 store 字段'],
                        ] as const
                      ).map(([key, label]) => (
                        <label key={key} className="connection-checkbox">
                          <input
                            type="checkbox"
                            checked={compatibility[key] === false}
                            onChange={(event) => {
                              const next = { ...compatibility }
                              if (event.target.checked) next[key] = false
                              else delete next[key]
                              setCompatibility(next)
                            }}
                          />
                          {label}
                        </label>
                      ))}
                    </>
                  ) : null}
                </div>
              </details>
            </>
          )}
        </fieldset>
        {(!connection && presetId === 'chatgpt' ? chatgpt.notice : error) ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {!connection && presetId === 'chatgpt' ? chatgpt.notice : error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
            取消
          </Button>
          {!connection && presetId === 'chatgpt' ? (
            <Button
              type="button"
              disabled={busy || !chatgpt.enabled || chatgpt.pending}
              onClick={() => {
                setStartingLogin(true)
                void chatgpt.onLogin().finally(() => setStartingLogin(false))
              }}
            >
              {startingLogin ? '正在连接…' : 'Continue with ChatGPT'}
            </Button>
          ) : (
            <Button type="submit" disabled={busy}>
              {saving ? '正在保存…' : '保存连接'}
            </Button>
          )}
        </div>
      </form>
    </dialog>
  )
}
