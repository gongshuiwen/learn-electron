# Pi Chat · Web + Desktop

React 前端、独立 Node 后端与 Electron 桌面集成组成的单用户聊天应用。三端可以分别启动、构建和测试；桌面与浏览器共用 HTTP + SSE 协议。Pi 被封装为可替换的 AgentEngine，首版仅提供聊天，不开放文件、命令或第三方扩展。

## 目录与责任

```text
apps/web/                   React 界面、HTTP 客户端、事件流与主题
apps/server/                HTTP API、鉴权、任务调度、SQLite 存储与启动入口
apps/desktop/               Electron 窗口、系统集成、本地服务监管与代理
packages/contracts/         应用自己的请求、响应、事件和参数校验
packages/agent-runtime/     AgentEngine 接口、Pi 适配器、显式模拟引擎
scripts/                    后端构建和桌面运行时准备
```

- 前端不导入 Electron、后端实现或 Pi，聊天仅使用 `/api/v1`。
- 后端不依赖 Electron。`ChatService` 管理会话、任务、取消和事件订阅；HTTP 层负责鉴权、请求校验与 SSE 传输。`startServer()` 可注入假引擎，HTTP 路由不依赖 Pi 会话类型。
- 跨包源码通过 workspace 包名导入；现有 lint 会约束 Web、后端、桌面、运行层和契约之间的静态导入边界。
- `contracts` 定义 HTTP 消息与校验，`contracts/native` 定义共享的最小主题和桌面桥接契约，不包含 Electron 类型。
- Electron preload 仅暴露主题和 API 基地址。前端统一通过 platform 使用桌面能力。
- Runtime 仅返回引擎信息与运行结果；HTTP 版本及响应由后端添加，运行层不依赖前端或传输协议。
- Pi 负责完整模型上下文；SQLite 保存会话索引、消息投影、幂等请求和运行状态。前端只保存当前会话选择和主题。
- 保留原生菜单、托盘、窗口状态、日志、主题和更新机制。模板中的计数器、文件和通知演示页面已替换为聊天界面。

```text
web ─────────────→ contracts（HTTP / native）
server ──────────→ contracts + agent-runtime
desktop ─────────→ contracts/native（通过进程监管运行 server 产物）
agent-runtime ───→ Pi
```

根配置与构建脚本属于共享工具链。根 `package.json` 同时作为 Electron 交付清单，保留与 desktop 包一致的 Electron 生产依赖，供打包器收集；业务依赖由各工作区声明。

## 环境

使用 `.nvmrc` 的 Node.js 24，最低 24.13，包管理器为 npm。SQLite 使用固定 Node 运行时内置的 `node:sqlite`，当前 Node 会输出实验 API 提示。Windows 项目命令优先 PowerShell 7。

```powershell
npm ci
Copy-Item .env.example .env
```

编辑 `.env`：为 `APP_API_TOKEN` 填入随机令牌。可使用以下命令生成，再复制到文件：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`.env`、`.data/`、构建产物不进入 Git。

## 前后端分别运行

两个终端分别执行：

```powershell
npm run dev:server
npm run dev:web
```

后端默认监听 `127.0.0.1:4318`。Vite 将 `/api` 转发给后端，在服务端注入 `.env` 中的访问令牌，令牌和模型 API key 都不会进入前端构建。`APP_SERVER_URL` 可覆盖代理目标。

首次验证可将 `.env` 的 `APP_ENGINE` 改为 `mock`：这是明确标识的离线演示，不会自动替代配置错误的真实模型。

真实 Pi 模式使用 `APP_ENGINE=pi`。以 DeepSeek 为例配置 `PI_PROVIDER=deepseek` 和 `DEEPSEEK_API_KEY`，`PI_MODEL` 可填写 Pi 模型目录中的 ID；留空时选择该提供商有凭据的可用模型。其他提供商使用 Pi 对应的环境变量。模型与密钥统一由服务端管理，首版不提供浏览器密钥设置页。

Pi 使用应用专属的工作目录、设置、内存凭据存储和会话目录，不加载用户的全局 Pi 配置、skills、扩展或默认工具。缺少有效模型时仍可启动和查看历史，界面会提示配置问题。

## 桌面运行

```powershell
npm run dev
```

开发桌面显式读取项目根目录 `.env`。Electron 启动专用的 `desktop-child.mjs` 后端入口，每次生成新的进程间访问凭证，并等待 ready 握手后创建界面。独立后端通过 `cli.ts` 启动；两个入口共用服务启动与清理逻辑，桌面子进程不读取工作目录的 `.env`。开发需要 Node；安装后的应用自带 Node，不依赖系统 Node 或全局 pi。

桌面开发会监听后端、Runtime 和契约源码，先重新构建后端，再由 electron-vite 重启应用。开发启动不执行类型检查；使用 `npm run check` 或 `npm run build` 验证类型。

桌面加载受限的 `app://desktop` 页面；开发时加载 Vite 页面。两者的 API 均由主进程向固定本地后端代理并注入凭证，renderer 不接触令牌。代理只接受可信来源和 `/api/` 路径。

安装版本只继承启动环境，不读取任意工作目录的 `.env`。设置 Pi 模型环境变量后再启动应用。桌面会话保存在 `userData/agent`；独立后端默认保存在项目 `.data/`，两者不自动同步。

退出时请求后端取消活动操作、写入状态并关闭。父进程断开也会关闭服务；异常退出后未完成任务在下次启动标记为中断，不自动重放。同一数据目录只允许一个后端实例，崩溃后所有权锁自动回收可能需要约 5 秒。

## 独立构建与工作区命令

```powershell
npm run build:web
npm run build:server
npm run start:server
npm run build
```

- `build:web` 只检查和构建前端，输出 `out/web`。
- `build:server` 只检查和构建后端及 Runtime，输出独立启动入口 `out/server/index.mjs`、桌面入口 `desktop-child.mjs` 与程序化入口 `server.mjs`。
- `build` 组合检查并生成桌面产物，前端输出 `out/renderer`。
- 后端构建对 Pi 保留外部依赖，独立部署需同时提供其生产依赖。

也可以使用 `npm run dev -w @learn-electron/web`、`npm run dev -w @learn-electron/server`，以及各工作区的 build/typecheck/test 命令。根脚本负责构建工具配置，业务源码保持在对应工作区。

## 协议与恢复

| 接口                                  | 行为                                        |
| ------------------------------------- | ------------------------------------------- |
| `GET /api/v1/meta`                    | 协议版本、引擎、模型和能力                  |
| `GET /api/v1/conversations`           | 会话列表                                    |
| `POST /api/v1/conversations`          | 创建会话                                    |
| `GET /api/v1/conversations/:id`       | 带序号的会话快照                            |
| `PATCH /api/v1/conversations/:id`     | 重命名，正文 `{title}`                      |
| `DELETE /api/v1/conversations/:id`    | 删除非活动会话及其 Pi 上下文                |
| `POST /api/v1/conversations/:id/runs` | 正文 `{message,requestId}`，返回 202 与 Run |
| `GET /api/v1/runs/:id/events`         | SSE：快照、文本增量、最终消息和任务状态     |
| `POST /api/v1/runs/:id/cancel`        | 幂等取消请求                                |

所有 API 请求需要 `Authorization: Bearer <APP_API_TOKEN>`。错误采用 `{error:{code,message}}`。同一会话只允许一个活动任务；同一 requestId 与相同正文会返回原任务，不同正文返回冲突。

每次 SSE 连接首先返回权威快照，之后推送有序事件。重连直接以新快照替换视图，不依赖无限保留的 token 日志。刷新页面不会取消后端运行。取消保留部分输出；进程崩溃或服务关闭将未完成任务标为 interrupted。首版不提供跨进程自动续跑。

后端只绑定回环地址，检查 Host、Origin 和 Bearer。独立生产 Web 应使用有身份认证的反向代理提供 HTTPS、静态前端与 `/api` 路由，并配置明确的 `APP_ALLOWED_ORIGINS`；关闭代理的 SSE 缓冲。当前是单用户服务，没有账户、租户隔离、配额或公网直接暴露模式。

## 测试

测试随所属应用或包维护，各工作区拥有自己的 `test` 命令：

```text
apps/web/test/web.test.mjs
apps/server/test/server.test.mjs
apps/server/test/store.test.mjs
apps/server/test/entrypoint.test.mjs
apps/desktop/test/smoke.test.mjs
apps/desktop/test/integration/*.test.mjs
apps/desktop/test/packaged.test.mjs
packages/contracts/test/contracts.test.mjs
packages/agent-runtime/test/runtime.test.mjs
packages/agent-runtime/test/pi-engine.test.mjs
```

运行指定包的测试：

```powershell
npm test --workspace @learn-electron/web
npm test --workspace @learn-electron/server
npm test --workspace @learn-electron/contracts
npm test --workspace @learn-electron/agent-runtime
npm test --workspace @learn-electron/desktop
npm run test:packaged --workspace @learn-electron/desktop
```

根目录 `npm test` 聚合所有提供 `test` 命令的工作区。`test:web`、`test:server`、`test:contracts`、`test:runtime`、`test:desktop` 均委托对应工作区；`test:smoke` 只运行桌面启动与聊天链路。`test:packaged` 需显式执行，不包含在常规 `npm test` 中。CI 执行完整桌面集成测试。`npm run check` 执行全仓库静态检查。

后端 HTTP 测试使用真实 HTTP/SSE、SQLite 和可注入假引擎验证鉴权、CRUD、幂等、取消和恢复；存储测试专门验证事务回滚，入口测试验证环境加载和进程启停。它们直接加载本包源码并执行类型检查，不依赖桌面产物。`contracts` 通过纯函数测试验证请求边界、事件格式和标识一致性。Pi 适配测试使用 SDK 自带的离线 provider，运行真实 session、事件与上下文持久化，验证文本转换、会话续接、取消、失败和资源清理。

Web 测试构建前端，使用 Playwright 和本机 Chrome 验证生产界面与模拟 API；可用 `PLAYWRIGHT_CHANNEL=msedge` 切换 Edge。各场景独立创建浏览器 context 和假服务状态，分别验证会话与渲染、流恢复、请求重试、导航竞态、主题和兼容性提示。假服务只通过显式重命名请求修改标题。

桌面测试通过 `pretest` 准备前端、后端和 Electron，按原生集成、生命周期、窗口状态和主题组织；每个场景使用独立 profile，文件串行执行。薄 smoke 使用明确的 mock 引擎验证桌面与本地服务链路。Windows `test:packaged` 通过 `pretest:packaged` 准备交付物，并复制到仓库外，验证无系统 Node 的运行、历史恢复、后台进程清理，以及生产 Pi 依赖的离线加载。自动化测试不需要真实模型密钥；真实提供商网络连接不在这些离线测试的覆盖范围内。

桌面页面恢复测试在应用事件边界注入退出事件，实际执行页面重载并验证 IPC 和后端连续性；不将操作系统原生崩溃事件的投递计为已验证。

## Windows 打包

```powershell
npm run pack
npm run dist
```

`prepare:runtime` 将当前 Node 二进制及其许可证放入 `out/runtime`，并准备 `out/server` 的生产依赖。后端构建外置依赖与交付清单共用 `scripts/server-dependencies.mjs`，依据工作区声明生成；交付依赖复用根锁文件的版本，通过 `npm ci` 安装后裁去其他工作区的包。打包应在目标操作系统及架构上运行。Node 及自包含的 server 放在 `resources/runtime`、`resources/server`，位于 ASAR 外；独立 Node 无法读取 Electron ASAR。后端的 `node_modules` 使用单独的资源映射，避免被打包器的目录过滤规则跳过。

`pack` 生成 `dist/win-unpacked/Learn Electron.exe`；`dist` 生成 NSIS 安装包。两者均不自动发布。应用 ID、名称、图标、签名和 GitHub 更新源继续由 `electron-builder.yml` 配置；发布前需要替换模板标识及仓库地址。

## 后续扩展位置

新增工具在 Runtime 中实现并经过工具策略授权；工作目录本身不构成权限沙箱。新增 Agent 引擎实现 AgentEngine，新增存储替换后端 Store，新增桌面能力放入受限 preload。公开 API 不直接暴露 Pi 类型。前后端独立部署时按 `/api/v1/meta` 协议及能力兼容；桌面分发固定经过测试的前端、后端、Pi 和 Node 组合。

MIT 许可证，保留模板原有版权声明，新增依赖遵循各自许可证。
