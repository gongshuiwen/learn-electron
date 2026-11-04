# 前后端协议

本文记录当前 `/api/v1` 的交互语义。字段、联合类型和参数校验以 [contracts](../packages/contracts/src/index.ts) 为准；HTTP 行为见 [server.ts](../apps/server/src/server.ts)，任务语义见 [ChatService](../apps/server/src/chat-service.ts)。架构与运行边界见 [architecture.md](architecture.md)。

## 连接与版本

- 客户端先读取 `GET /api/v1/meta`，检查 `apiVersion === API_VERSION`，再使用 `configured`、`model` 和 `capabilities` 展示模型状态。当前 `API_VERSION` 为 `1`。`configured` 由本地模型与凭据配置决定；远端鉴权、额度和网络问题在执行时报告。
- 后端仅监听回环地址，校验精确的 Host、Origin 白名单与 `Authorization: Bearer <token>`。通过 Host/Origin 检查的 `OPTIONS` 预检返回 `204`，无需 Bearer。
- Web 的代理、Electron 的主进程代理负责注入 Bearer，renderer 无需保存令牌或模型密钥。直接调用后端的其他客户端自行携带 Bearer。
- 写入消息、重命名使用 `Content-Type: application/json`，这些接口的 JSON 正文上限为 160 KiB。普通响应为 JSON；`204` 无正文。

浏览器使用 `fetch` 读取事件流，便于统一处理请求、中断与协议校验。生产 Web 的反向代理需转发 `/api`，关闭 SSE 缓冲，并负责外部用户认证；本地服务令牌不是多用户账户系统。

## 运行时校验与兼容性

- 后端通过 contracts 校验消息提交和重命名参数；客户端对 SSE 执行 JSON、事件形状、版本与标识校验。
- 普通 HTTP 响应由 [request<T>](../apps/web/src/features/chat/api.ts) 读取后作类型断言，尚无完整 DTO 运行时校验；`/meta` 的版本检查不代表其全部字段均已验证。
- 已知类型的额外字段可被当前解析接受，保留或剔除行为不作协议保证。未知事件类型按协议错误处理，恢复行为见 [SSE 规则](#sse-事件)；目前没有跨版本旧客户端兼容性保证。
- 当前要求 `apiVersion` 严格相等，`capabilities` 只声明 `tools`，尚未实现版本范围或完整能力协商。

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

会话和任务 ID 由服务端生成，客户端按不透明标识使用。会话列表按更新时间倒序排列；当前不分页。新会话标题为“新对话”，发送消息不会自动改名，改名通过 PATCH 完成。

参数约束：

- `message` 必须是非空白字符串，原始长度最多 32000；保存与幂等比较前会去除首尾空白。
- `requestId` 必须为 8–128 位字符串，只含 ASCII 字母、数字、下划线或连字符。客户端可使用 UUID。
- `title` 去除首尾空白后长度为 1–100。
- 上述长度按 JavaScript `string.length` 计算，具体规则以 contracts 的解析函数为准。

### 提交与幂等

1. 创建或选择会话，提交消息与新 `requestId`。
2. 服务端在一个事务中保存用户消息、占位助手消息和任务，返回 `202 Run`。
3. 客户端获取会话快照，并在当前任务活动时连接事件流。

幂等键的范围是同一会话。同一键与相同规范化消息返回原任务，不再次调用模型；同一键配不同消息返回 `409 idempotency_conflict`。已确认的原任务即使在服务重启、模型随后缺少配置时也可查询返回。`202` 也用于幂等重试，因此返回的任务可能已经结束。

POST 响应或后续快照丢失时，客户端重试同一次提交应复用原键。确认提交成功后，再次发送相同文本属于新提交，应生成新键。

每个会话只允许一个活动任务，其他新提交返回 `409 conversation_busy`；不同会话可各自生成。删除中的会话也拒绝新任务。

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

取消接口幂等。活动任务通常先返回 `cancelling`，客户端继续接收最终状态；已经结束的任务返回其现有状态。关闭页面或断开 SSE 不会取消模型调用，取消必须调用 cancel 接口。

删除活动会话返回 `409 conversation_busy`。可删除时，先清理 Pi 原生上下文，再删除 SQLite 元数据；上下文清理失败时保留元数据。服务关闭会等待已经开始的删除完成，再关闭 Store 和释放目录所有权。

## SSE 事件

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

事件与快照中的 `sequence` 是同一会话内持久化的单调序号，不是全局或仅属于某次连接的计数。客户端应用增量时忽略不大于当前快照序号的事件，并校验流的 `runId`、`conversationId` 一致。新连接第一条必须为 `snapshot`。

活动任务结束时，服务端在事务中保存最终消息和任务状态，再向现有订阅依次发送 `message.completed`、终态 `run.updated` 并关闭连接。这里的 `message.completed` 表示消息写入已结束，其 `status` 在失败或取消时仍可以是 `interrupted`。

恢复规则：

1. 每次连接首先发送最新会话快照；当前不根据 `Last-Event-ID` 重放历史增量。
2. 连接提前结束且任务仍活动时，客户端重新连接，由新快照恢复；当前 UI 使用有上限的指数退避。
3. 刷新页面从 HTTP 快照恢复选中的会话，然后订阅当前活动任务。
4. 版本、JSON、事件形状或标识不兼容属于协议错误，停止自动重连；用户手动重试时先结束旧监听，再重新加载权威快照。

订阅的是 URL 中的任务，但 `snapshot.run` 表示会话的最新任务。查询一个已经结束的旧任务流时，服务端只发当前会话快照并关闭；快照可以包含更新的活动任务，不能要求 `snapshot.run.id` 总与外层 `runId` 相等。客户端应根据快照转为订阅最新任务。

服务端每 15 秒发送 `: heartbeat` 注释保持连接。慢消费者使写缓冲超过 1 MiB 时会被断开，应按快照重连；服务端不为每个消费者保存无限增量日志。

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

| HTTP 状态 | 主要 `error.code`                                      |
| --------- | ------------------------------------------------------ |
| 400       | `invalid_request`、`invalid_json`、`request_aborted`   |
| 401       | `unauthorized`                                         |
| 403       | `invalid_host`、`invalid_origin`                       |
| 404       | `conversation_not_found`、`run_not_found`、`not_found` |
| 405       | `method_not_allowed`                                   |
| 409       | `conversation_busy`、`idempotency_conflict`            |
| 413 / 415 | `body_too_large` / `unsupported_media_type`            |
| 503       | `engine_not_configured`、`shutting_down`               |
| 500       | `internal_error`                                       |

任务被接收后发生的模型失败通过 `Run.status = failed` 与 `Run.error` 表达，不会把已返回的 `202` 改成 HTTP 错误。SSE 响应头已经发送后发生错误会关闭连接，不再追加 JSON 错误正文。

桌面主进程代理连接不到后端时，另返回 `503 SERVICE_UNAVAILABLE`。协议中的错误消息用于显示，不应依赖其中文原文控制业务。

## 当前范围与维护

当前面向单用户聊天，没有账户、租户隔离、分页、跨进程自动续跑或增量历史重放。引擎未配置时仍可读取历史，但新任务返回 `503`，不会自动改用 mock。隔离与上下文说明见 [数据与配置归属](architecture.md#数据与配置归属)。

修改字段或校验时同步更新 contracts 与其测试；修改任务、状态或恢复语义时同步更新本文及相应模块测试。新增不兼容语义需明确版本策略，避免前后端独立演进时静默接受错误数据。
