# 前后端协议

本文记录当前 `/api/v1` 的交互语义。字段、联合类型和参数校验以 [contracts](../packages/contracts/src/index.ts) 为准；HTTP 行为见 [server.ts](../apps/server/src/server.ts)，任务语义见 [ChatService](../apps/server/src/chat-service.ts)。

## 通用约定

- 客户端先读取 `GET /api/v1/meta`，检查 `apiVersion === API_VERSION`，再使用 `configured`、`model` 和 `capabilities` 展示模型状态。当前 `API_VERSION` 为 `1`。`configured` 由本地模型与凭据配置决定；远端鉴权、额度和网络问题在执行时报告。
- `/meta` 描述默认模型；会话快照中的 `model` 描述该会话的有效模型状态，聊天界面优先使用它。两者都有 `selection`、具体 `target`、`configured` 和可选不可用原因 `reason`，不包含凭据。
- ChatGPT 模式额外返回 `authMode: "chatgpt"`。登录、连接与模型更新后重新读取 `/meta`；该接口不触发远端调用。未登录、缺少计划权限、未选可用模型或连接更新中时 `configured=false`。
- `capabilities` 只声明 `tools`，尚未实现版本范围或完整能力协商，不保证跨版本旧客户端兼容。
- 后端仅监听回环地址，校验精确的 Host、Origin 白名单与 `Authorization: Bearer <token>`。通过 Host/Origin 检查的 `OPTIONS` 预检返回 `204`，无需 Bearer。
- Web 的代理、Electron 的主进程代理负责注入 Bearer，renderer 无需保存服务令牌；模型凭据仅在配置提交时传入，读取接口不回显。直接调用后端的其他客户端自行携带 Bearer。
- 写入消息、重命名使用 `Content-Type: application/json`，这些接口的 JSON 正文上限为 160 KiB。普通响应为 JSON；`204` 无正文。
- 后端通过 contracts 校验消息提交和重命名参数；客户端通过同包解析器校验 HTTP 响应，SSE 另校验事件版本与标识。JSON 或响应形状不兼容时报告协议错误。
- 已知类型的额外字段可被当前解析接受，保留或剔除行为不作协议保证。未知事件类型按协议错误处理，恢复行为见 [重连恢复](#重连恢复)。

本地服务令牌不是多用户账户系统。生产 Web 部署见 [构建与交付](build-and-delivery.md#独立-web-部署)。

## HTTP 接口

下表路径省略 `/api/v1`，返回类型见 contracts 中的同名定义。

| 方法   | 路径                       | 正文                             | 成功响应                   |
| ------ | -------------------------- | -------------------------------- | -------------------------- |
| GET    | `/meta`                    | 无                               | `200 ServiceMeta`          |
| GET    | `/conversations`           | 无                               | `200 Conversation[]`       |
| POST   | `/conversations`           | 可选 `{ "selection": ModelRef }` | `201 Conversation`         |
| GET    | `/conversations/:id`       | 无                               | `200 ConversationSnapshot` |
| PUT    | `/conversations/:id/model` | `ModelRef`                       | `200 ConversationSnapshot` |
| PATCH  | `/conversations/:id`       | `{ "title": "标题" }`            | `200 Conversation`         |
| DELETE | `/conversations/:id`       | 无                               | `204`                      |
| POST   | `/conversations/:id/runs`  | `StartRunRequest`                | `202 Run`                  |
| GET    | `/runs/:id/events`         | 无                               | `200 text/event-stream`    |
| POST   | `/runs/:id/cancel`         | 无需正文                         | `200 Run`                  |

### 模型供应商与默认选择

类型与校验见 [contracts/models](../packages/contracts/src/models.ts)，纯领域模型见 [model-connections](../packages/model-connections/src/index.ts)。供应商品牌 `vendor`、实例 `id` 与接口协议相互独立；同品牌、同地址可以有多个实例，各自保存凭据和模型目录。

| 方法   | 路径                                  | 正文                                             | 成功响应                 |
| ------ | ------------------------------------- | ------------------------------------------------ | ------------------------ |
| GET    | `/model-adapters`                     | 无                                               | `200 ModelAdapterView[]` |
| GET    | `/model-providers`                    | 无                                               | `200 ProvidersState`     |
| POST   | `/model-providers`                    | `SaveProviderRequest` 或 `{ "kind": "chatgpt" }` | `201 ProvidersState`     |
| PATCH  | `/model-providers/:id`                | 端点完整配置与可选凭据更新                       | `200 ProvidersState`     |
| DELETE | `/model-providers/:id`                | 无                                               | `200 ProvidersState`     |
| GET    | `/model-providers/:id/models`         | 无，只读缓存                                     | `200 ModelDefinition[]`  |
| POST   | `/model-providers/:id/models/refresh` | 无，请求上游                                     | `200 ModelDefinition[]`  |
| POST   | `/model-providers/:id/test`           | `{ "modelId": "模型" }`                          | `204`                    |
| PUT    | `/model`                              | `ModelRef`                                       | `200 ProvidersState`     |

`ModelRef` 直接指定供应商实例和模型：

```json
{ "instanceId": "实例", "modelId": "模型" }
```

`ProvidersState` 返回 `instances`、`defaultSelection: ModelRef | null` 和 `chatgpt: { enabled, pendingLogin? }`。实例以 `kind` 区分端点与 ChatGPT 账号；保存、登录、目录与测试均不修改默认选择，只有 `PUT /model` 显式设置新会话的默认值。

端点配置包含 `vendor`、名称、协议、基地址、认证方式、模型元数据与兼容选项，读取时另有稳定 ID 和配置版本。现有适配器支持 `openai-chat`、`openai-responses`、`anthropic-messages`、`google-generative`；前端根据适配器描述显示协议和认证选项。兼容这些协议的供应商可直接配置，其他协议需实现适配器。OpenAI 兼容协议支持无需认证与自定义请求头。模型最多 200 个，ID 可手填；最大输出不超过上下文。兼容选项只适用于 Chat Completions，未知选项拒绝。

写入时 `apiKey` 缺省保留、字符串替换、`null` 清除；`headers` 缺省保留、对象替换、`{}` 清除。值按字面量处理，不插值环境变量或执行命令。读取只返回 `hasCredential`、`hasHeaders`，不返回原始密钥和请求头。端点发现保留手填模型并合并目录，失败保留原配置。无目录接口时可手填接入。

配置先持久化再发布，不要求重启。更换端点协议或地址返回 `409 connection_identity_changed`，须新建实例。更新、删除、测试、刷新和重新授权按实例排他；该实例有活动任务时返回 `409 connection_busy`，其他实例仍可生成。默认选择可在生成期间修改，已绑定会话不受影响。删除实例会清空引用它的默认选择，不自动选择替代模型；已有会话保留绑定并显示不可用。ChatGPT 实例需先退出或取消登录后才能移除。

删除 ChatGPT 实例时先保存模型配置、再删除账号记录。任何一步失败均可重试；如果第二步失败，默认选择可能已清空，但账号记录仍保留。

测试发送独立简短请求，不创建会话或改变原生上下文；测试和端点目录刷新最长 15 秒，服务关闭时取消。ChatGPT 测试发现认证失效或计划权限不足时，只更新该账号的授权状态。模型生成与测试保留脱敏分类错误码 `auth_required`、`quota_exceeded`、`model_unavailable`、`provider_failed`，不回显上游正文。模型传输拒绝 301/302/303/307/308 重定向，避免转发凭据。旧 `/providers`、`/connections` 和 `/auth/chatgpt/*` 不再提供。

### 实例授权

类型与校验见 [contracts/chatgpt](../packages/contracts/src/chatgpt.ts)。先通过 `POST /model-providers { "kind": "chatgpt" }` 创建实例，再按其 ID 登录或重新授权：

| 方法 | 路径                                 | 正文 | 成功响应                         |
| ---- | ------------------------------------ | ---- | -------------------------------- |
| POST | `/model-providers/:id/auth/attempts` | 无   | `201 ChatGPTLogin`               |
| GET  | `/model-auth-attempts/:id`           | 无   | `200 ChatGPTLogin`               |
| POST | `/model-auth-attempts/:id/cancel`    | 无   | `204`                            |
| POST | `/model-providers/:id/auth/logout`   | 无   | `200 { "revoked": true或false }` |

真实引擎开放 ChatGPT 登录；mock 的供应商列表返回 `chatgpt.enabled=false`，配置操作返回 `409 engine_disabled`。多个 ChatGPT 实例可在不同会话同时使用，凭据与失败状态按实例隔离。重新授权复用该实例的注册并校验身份一致；需要其他账号时新建实例。

授权只保存凭据，成功、取消、失败、超时或迟到结果都不改变默认选择。进行中的授权只阻止该实例的新调用。登录结果 `completed` 返回 `instanceId`，客户端可随后通过 `PUT /model` 选用；选择保存失败不丢弃已保存凭据。登录进度为 `pending`、`completed`、`cancelled`、`expired`、`failed`，不含 token。首期每次一个登录尝试，十五分钟超时，退出进程时取消；进行中的尝试经 `GET /model-providers` 的 `chatgpt.pendingLogin` 恢复，终态保留到下次尝试。

重启或新尝试替换旧尝试后，查询、取消可能返回 `404 login_not_found`。客户端停止旧轮询并刷新实例和模型状态，无需重载页面；临时错误保留进度并重试。账号状态有 `signed_out`、`connected`、`reauth_required`、`authorizing` 和 `busy`，后两者表示该实例暂不可用；`planUsage` 表示实际授予的计划权限。账号显示名包含实例标识，即使使用相同邮箱也可区分。目录为账号权限与执行适配器支持范围的交集；GET 只读缓存，显式刷新才访问上游。

退出先阻止指定实例的新调用，只取消绑定该实例的活动任务，再等待在途刷新、撤销最新远程令牌并清除本地令牌。退出进行中，同实例重新授权返回 `409 connection_busy`；其他实例仍可申请授权，其任务不受影响。历史、注册信息、默认选择和会话绑定保留，退出完成后可重新授权同一实例。`revoked=false` 表示本地退出已完成，远程撤销未确认。

正常关闭开始后拒绝尚未开始的排队登录；若回调监听器正在启动，先回收监听器再结束登录请求，不发布新的待完成尝试。已开始的令牌轮换仍等待落盘，避免丢失已签发的替换令牌。已开始的账号退出在停止任务、远程撤销和本地保存期间均会被关闭流程等待，成功或失败后才释放数据目录。桌面宿主仍有 60 秒强制终止兜底，强制终止时无法保证退出操作完成。

### 参数约束

| 字段             | 约束                                                                              |
| ---------------- | --------------------------------------------------------------------------------- |
| `message`        | 必须是非空白字符串，原始长度最多 32000；保存与幂等比较前会去除首尾空白。          |
| `requestId`      | 必须为 8–128 位字符串，只含 ASCII 字母、数字、下划线或连字符。客户端可使用 UUID。 |
| `expectedTarget` | 真实引擎的新任务必须提供界面显示的实例和模型引用，演示引擎可省略。                |
| `title`          | 去除首尾空白后长度为 1–100。                                                      |

上述长度按 JavaScript `string.length` 计算，具体规则以 contracts 的解析函数为准。

## 会话与任务语义

### 会话操作

会话和任务 ID 由服务端生成，客户端按不透明标识使用。会话列表按更新时间倒序排列；当前不分页。新会话标题为“新对话”，发送消息不会自动改名，改名通过 PATCH 完成。

删除活动会话返回 `409 conversation_busy`。资源清理失败时，删除请求失败，会话和消息记录仍保留。资源清理顺序见 [生命周期与资源所有权](architecture.md#生命周期与资源所有权)。

### 提交与幂等

1. 创建或选择会话，提交消息与新 `requestId`；真实引擎还须提交界面显示的 `expectedTarget: ModelRef`。
2. 服务端在一个事务中保存用户消息、占位助手消息和任务，返回 `202 Run`。
3. 客户端获取会话快照，并在当前任务活动时连接事件流。

幂等键的范围是同一会话。同一键与相同规范化消息返回原任务，不再次调用模型；同一键配不同消息返回 `409 idempotency_conflict`。已确认的原任务即使在服务重启、模型随后缺少配置时也可查询返回。`202` 也用于幂等重试，因此返回的任务可能已经结束。

POST 响应或后续快照丢失时，客户端重试同一次提交应复用原键和目标。确认提交成功后，再次发送相同文本属于新提交，应生成新键。演示引擎没有真实目标，可以省略 `expectedTarget`。

每个会话只允许一个活动任务，其他新提交返回 `409 conversation_busy`；不同会话可各自生成。删除中的会话也拒绝新任务。

引擎未配置时仍可读取历史，但新任务返回 `503`，不会自动改用 mock。

创建会话时可以提交具体实例和模型；省略时复制当前默认选择。聊天界面发送新会话的首条消息时提交当前显示的选择，避免其他客户端修改默认值后意外发送到其他实例。空会话也可通过 `PUT /conversations/:id/model` 更新自己的选择，返回带有效模型状态的完整快照，不修改全局默认值、不创建原生上下文或调用模型。选择先验证目标，再在事务中检查会话仍未绑定且没有消息；成功时增加 `sequence`，无效目标不改变原选择，已有绑定或消息返回 `409 connection_changed`。聊天框对这类会话的切换使用 `POST /conversations` 创建新会话，保留原历史。未保存选择的空会话在首次提交时读取默认值。接纳任务时在事务中检查 `expectedTarget` 与实际目标一致，并确认选择未发生并发变更；真实引擎缺少目标或目标不匹配返回 `409 connection_changed`，不写消息、不调用模型。首次接纳时将具体 `binding: {instanceId, modelId}` 与消息、任务一起写入 SQLite；`Run.target` 记录实际目标。之后只使用绑定，默认选择变化不会将旧上下文发往其他实例。

绑定实例或模型不可用时，新任务返回 `503 engine_not_configured`，不写消息、不调用其他实例。演示会话或缺少具体模型绑定的会话不能切换到真实模型续聊，继续生成返回 `409 connection_changed`。原 requestId 的幂等查询优先返回原任务。

会话服务负责历史、幂等、取消和绑定，模型服务解析选择并提供实例凭据，执行端口接收明确目标与取消信号，不读取全局当前模型。Pi 的原生上下文由适配器管理。任何实例均不回退到环境 Key 或其他实例；成功要求完整终止事件，截断或失败流保留部分文本并标记失败。

### 状态与取消

| 对象    | 状态                    | 含义                                     |
| ------- | ----------------------- | ---------------------------------------- |
| Run     | `running`、`cancelling` | 活动任务；取消已请求不等于已经结束       |
| Run     | `completed`             | 模型调用成功                             |
| Run     | `cancelled`             | 取消完成，保留已保存的部分文本           |
| Run     | `failed`                | 模型或任务处理失败，公开错误使用脱敏信息 |
| Run     | `interrupted`           | 服务关闭或异常退出后恢复，不自动重放     |
| Message | `streaming`             | 助手消息尚未结束                         |
| Message | `complete`              | 用户消息或成功完成的助手消息             |
| Message | `interrupted`           | 未完整完成的助手消息，可保留部分输出     |

取消接口幂等。活动任务通常先返回 `cancelling`，客户端继续接收最终状态；已经结束的任务返回其现有状态。关闭页面或断开 SSE 不会取消模型调用，客户端主动取消须调用 cancel 接口。

单次回复最多保存 1,000,000 个字符（按 `string.length` 计算）；流式增量超限会由后端取消任务，保留已保存文本。

## SSE 事件

### 格式与载荷

连接使用 `Accept: text/event-stream`。每条事件由 `id`、`data` 和空行组成；类型在 JSON 的 `type` 中，服务端不发送 SSE `event:` 字段。例如：

```text
id: 2
data: {"apiVersion":1,"conversationId":"conversation-id","runId":"run-id","sequence":2,"type":"message.delta","messageId":"assistant-id","delta":"你好"}

```

示例中的标识仅为占位值。所有事件均包含版本、会话 ID、任务 ID 和序号，事件载荷如下：

| `type`              | 载荷                             | 客户端处理                             |
| ------------------- | -------------------------------- | -------------------------------------- |
| `snapshot`          | `snapshot: ConversationSnapshot` | 用权威快照替换当前视图                 |
| `message.delta`     | `messageId`、`delta`             | 向目标助手消息追加文本                 |
| `message.completed` | `message: Message`               | 用最终消息替换投影，不能只依赖此前增量 |
| `run.updated`       | `run: Run`                       | 更新任务状态，终态结束当前任务监听     |

### 顺序与终态

事件与快照中的 `sequence` 是同一会话内持久化的单调序号，不是全局或仅属于某次连接的计数。客户端应用增量时忽略不大于当前快照序号的事件，并校验流的 `runId`、`conversationId` 一致。

活动任务结束时，服务端在事务中保存最终消息和任务状态，再向现有订阅依次发送 `message.completed`、终态 `run.updated` 并关闭连接。这里的 `message.completed` 表示消息写入已结束，其 `status` 在失败或取消时仍可以是 `interrupted`。

终态保存失败时的行为见 [终态保存失败](#终态保存失败)。

### 重连恢复

1. 每次连接的首条事件必须为最新会话快照 `snapshot`；当前不根据 `Last-Event-ID` 重放历史增量。
2. 连接提前结束且任务仍活动时，客户端重新连接，由新快照恢复。网络故障及 HTTP `408`、`429`、`5xx` 使用有上限的指数退避；其他 HTTP 错误停止自动重连并显示提示。
3. 刷新页面从 HTTP 快照恢复选中的会话，然后订阅当前活动任务。
4. 版本、JSON、事件形状或标识不兼容属于协议错误，停止自动重连；用户手动重试时先结束旧监听，再重新加载权威快照。

订阅的是 URL 中的任务，但 `snapshot.run` 表示会话的最新任务。查询一个已经结束的旧任务流时，服务端只发当前会话快照并关闭；快照可以包含更新的活动任务，不能要求 `snapshot.run.id` 总与外层 `runId` 相等。客户端应根据快照转为订阅最新任务。

### 传输限制

- 快照包含完整会话历史，客户端按网络分片累积完整事件，不设固定帧长度上限；当前仍未分页。
- 服务端每 15 秒发送 `: heartbeat` 注释保持连接。
- 慢消费者使写缓冲超过 1 MiB 时会被断开，应按快照重连；该缓冲阈值不限制单个快照的大小。

## 错误

后端 API 的 HTTP 错误采用 `ApiError`，例如：

```json
{
  "error": {
    "code": "conversation_busy",
    "message": "请先停止当前任务，再删除会话"
  }
}
```

| HTTP 状态 | 主要 `error.code`                                               |
| --------- | --------------------------------------------------------------- |
| 400       | `invalid_request`、`invalid_json`、`request_aborted`            |
| 401       | `unauthorized`                                                  |
| 403       | `invalid_host`、`invalid_origin`                                |
| 404       | `conversation_not_found`、`run_not_found`、`not_found`          |
| 405       | `method_not_allowed`                                            |
| 409       | `conversation_busy`、`idempotency_conflict`                     |
| 413 / 415 | `body_too_large` / `unsupported_media_type`                     |
| 503       | `engine_not_configured`、`storage_unavailable`、`shutting_down` |
| 500       | `internal_error`                                                |

任务被接收后发生的模型失败通过 `Run.status = failed` 与 `Run.error` 表达，不会把已返回的 `202` 改成 HTTP 错误。可识别的模型错误还返回可选 `Run.errorCode`：`auth_required`、`permission_missing`、`quota_exceeded`、`model_unavailable`、`connection_changed`、`provider_failed`。公开文本始终脱敏，客户端不依赖中文原文控制业务。SSE 响应头已经发送后发生错误会关闭连接，不再追加 JSON 错误正文。

桌面主进程代理连接不到后端时，另返回 `503 SERVICE_UNAVAILABLE`。客户端统一保留 HTTP 状态、错误 code 和显示消息；代理返回非 JSON 错误页时使用状态码提示。错误消息用于显示，不应依赖其中文原文控制业务。

### 终态保存失败

- 服务端保留原结果并断开订阅，保存重试不重新调用模型。
- 查询该会话或任务、重连、提交或删除该会话时重试保存；正常关闭时也会尝试保存待提交结果。
- 保存重试仍失败时，对应请求返回 `503 storage_unavailable`；取消请求仍会中止正在运行的模型。
- 读取服务信息、会话列表及其他会话不会触发无关任务的保存重试。
- 若进程在保存成功前退出，下次启动仍按 `interrupted` 恢复，不保证恢复尚未落盘的最终结果。

## 维护约定

修改字段或校验时同步更新 contracts 与其测试；修改任务、状态或恢复语义时同步更新本文及相应模块测试。新增不兼容语义需明确版本策略，避免前后端独立演进时静默接受错误数据。
