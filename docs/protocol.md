# 前后端协议

本文记录当前 `/api/v1` 的交互语义。字段、联合类型和参数校验以 [contracts](../packages/contracts/src/index.ts) 为准；HTTP 行为见 [server.ts](../apps/server/src/server.ts)，任务语义见 [ChatService](../apps/server/src/chat-service.ts)。

## 通用约定

- 客户端先读取 `GET /api/v1/meta`，检查 `apiVersion === API_VERSION`，再使用 `configured`、`model` 和 `capabilities` 展示模型状态。当前 `API_VERSION` 为 `1`。`configured` 由本地模型与凭据配置决定；远端鉴权、额度和网络问题在执行时报告。
- ChatGPT 模式额外返回 `authMode: "chatgpt"`。登录、连接与模型更新后重新读取 `/meta`；该接口不触发远端调用。未登录、缺少计划权限、未选可用模型或连接更新中时 `configured=false`。
- `capabilities` 只声明 `tools`，尚未实现版本范围或完整能力协商，不保证跨版本旧客户端兼容。
- 后端仅监听回环地址，校验精确的 Host、Origin 白名单与 `Authorization: Bearer <token>`。通过 Host/Origin 检查的 `OPTIONS` 预检返回 `204`，无需 Bearer。
- Web 的代理、Electron 的主进程代理负责注入 Bearer，renderer 无需保存令牌或模型密钥。直接调用后端的其他客户端自行携带 Bearer。
- 写入消息、重命名使用 `Content-Type: application/json`，这些接口的 JSON 正文上限为 160 KiB。普通响应为 JSON；`204` 无正文。
- 后端通过 contracts 校验消息提交和重命名参数；客户端通过同包解析器校验 HTTP 响应，SSE 另校验事件版本与标识。JSON 或响应形状不兼容时报告协议错误。
- 已知类型的额外字段可被当前解析接受，保留或剔除行为不作协议保证。未知事件类型按协议错误处理，恢复行为见 [重连恢复](#重连恢复)。

本地服务令牌不是多用户账户系统。生产 Web 部署见 [构建与交付](build-and-delivery.md#独立-web-部署)。

## HTTP 接口

下表路径省略 `/api/v1`，返回类型见 contracts 中的同名定义。

| 方法   | 路径                      | 正文                                                 | 成功响应                   |
| ------ | ------------------------- | ---------------------------------------------------- | -------------------------- |
| GET    | `/meta`                   | 无                                                   | `200 ServiceMeta`          |
| GET    | `/conversations`          | 无                                                   | `200 Conversation[]`       |
| POST   | `/conversations`          | 无需正文                                             | `201 Conversation`         |
| GET    | `/conversations/:id`      | 无                                                   | `200 ConversationSnapshot` |
| PATCH  | `/conversations/:id`      | `{ "title": "标题" }`                                | `200 Conversation`         |
| DELETE | `/conversations/:id`      | 无                                                   | `204`                      |
| POST   | `/conversations/:id/runs` | `{ "message": "问题", "requestId": "request-0001" }` | `202 Run`                  |
| GET    | `/runs/:id/events`        | 无                                                   | `200 text/event-stream`    |
| POST   | `/runs/:id/cancel`        | 无需正文                                             | `200 Run`                  |

### ChatGPT 连接与模型

类型与校验见 [contracts/chatgpt](../packages/contracts/src/chatgpt.ts)。这些业务接口均需要现有本地服务鉴权，路径仍省略 `/api/v1`。

| 方法   | 路径                       | 正文                                    | 成功响应                         |
| ------ | -------------------------- | --------------------------------------- | -------------------------------- |
| GET    | `/auth/chatgpt`            | 无                                      | `200 ChatGPTState`               |
| POST   | `/auth/chatgpt/login`      | `{}` 或 `{ "profileId": "已保存连接" }` | `201 ChatGPTLogin`               |
| GET    | `/auth/chatgpt/logins/:id` | 无                                      | `200 ChatGPTLogin`               |
| DELETE | `/auth/chatgpt/logins/:id` | 无                                      | `204`                            |
| POST   | `/auth/chatgpt/select`     | `{ "profileId": "连接" }`               | `200 ChatGPTState`               |
| POST   | `/auth/chatgpt/logout`     | 无需正文                                | `200 { "revoked": true或false }` |
| GET    | `/models`                  | 无                                      | `200 ChatGPTModel[]`             |
| PUT    | `/model`                   | `{ "modelId": "模型" }`                 | `200 ServiceMeta`                |

环境密钥或 mock 模式下，状态接口返回 `enabled=false`，其他连接/模型操作返回 `409 auth_mode_disabled`。登录请求返回不含 token 的浏览器授权地址，客户端轮询进度；进度有 `pending`、`completed`、`cancelled`、`expired`、`failed`。每次仅一个登录尝试，默认十五分钟超时，进程退出会取消它。状态接口通过可选 `pendingLogin` 返回进行中的登录，刷新页面或更换标签后可恢复轮询、重新打开授权页或取消；终态结果只保留到下一次尝试。

服务重启或旧登录被新尝试替换后，查询、取消旧登录可能返回 `404 login_not_found`。客户端将其视为旧尝试已结束，停止旧轮询并重新读取连接、模型和服务状态，无需刷新页面即可重新登录；取消操作遇到相同错误也按已结束处理。轮询遇到临时网络或服务错误仍保留进度并重试。

连接状态区分 `signed_out`、`connected`、`reauth_required`，`planUsage` 表示实际授予的计划使用权限。已登录但 `planUsage=false` 时仍保留身份，客户端可重新授权。授权与 Token 交换在后端进行，HTTP DTO 不含令牌。`GET /models` 优先使用账户目录缓存，缓存为空时尝试拉取；`?refresh=1` 显式刷新，与 Pi 支持范围取交集，空列表不代表认证失败。

生成中更改连接、模型或开始授权返回 `409 connection_busy`；退出登录会先取消所有生成，再等待刷新并尝试撤销远程会话。`revoked=false` 表示本地令牌已清除，远程撤销未确认，应引导用户查看 ChatGPT 设置。历史记录不会随退出删除。

### 参数约束

| 字段        | 约束                                                                              |
| ----------- | --------------------------------------------------------------------------------- |
| `message`   | 必须是非空白字符串，原始长度最多 32000；保存与幂等比较前会去除首尾空白。          |
| `requestId` | 必须为 8–128 位字符串，只含 ASCII 字母、数字、下划线或连字符。客户端可使用 UUID。 |
| `title`     | 去除首尾空白后长度为 1–100。                                                      |

上述长度按 JavaScript `string.length` 计算，具体规则以 contracts 的解析函数为准。

## 会话与任务语义

### 会话操作

会话和任务 ID 由服务端生成，客户端按不透明标识使用。会话列表按更新时间倒序排列；当前不分页。新会话标题为“新对话”，发送消息不会自动改名，改名通过 PATCH 完成。

删除活动会话返回 `409 conversation_busy`。资源清理失败时，删除请求失败，会话和消息记录仍保留。资源清理顺序见 [生命周期与资源所有权](architecture.md#生命周期与资源所有权)。

### 提交与幂等

1. 创建或选择会话，提交消息与新 `requestId`。
2. 服务端在一个事务中保存用户消息、占位助手消息和任务，返回 `202 Run`。
3. 客户端获取会话快照，并在当前任务活动时连接事件流。

幂等键的范围是同一会话。同一键与相同规范化消息返回原任务，不再次调用模型；同一键配不同消息返回 `409 idempotency_conflict`。已确认的原任务即使在服务重启、模型随后缺少配置时也可查询返回。`202` 也用于幂等重试，因此返回的任务可能已经结束。

POST 响应或后续快照丢失时，客户端重试同一次提交应复用原键。确认提交成功后，再次发送相同文本属于新提交，应生成新键。

每个会话只允许一个活动任务，其他新提交返回 `409 conversation_busy`；不同会话可各自生成。删除中的会话也拒绝新任务。

引擎未配置时仍可读取历史，但新任务返回 `503`，不会自动改用 mock。

会话首次生成时绑定当前模型连接；旧数据已有历史的会话归属环境密钥模式。切换到其他连接后继续生成返回 `409 connection_changed`，不写入消息、不调用模型。原 requestId 的幂等查询仍优先返回原任务。ChatGPT 请求不回退到环境 API Key，成功必须有完整的模型终止事件，截断或失败流保留部分文本并标记失败。

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
