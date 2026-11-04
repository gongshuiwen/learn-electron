# Pi Chat · Web + Desktop

React 前端、独立 Node 后端与 Electron 桌面集成组成的单用户聊天应用。三端可以分别启动、构建和测试；桌面与浏览器共用 HTTP + SSE 协议。Pi 被封装为可替换的 AgentEngine，首版仅提供聊天，不开放文件、命令或第三方扩展。

## 项目文档

- [整体架构](docs/architecture.md)：模块与依赖、运行路径、数据归属、生命周期和交付边界。
- [前后端协议](docs/protocol.md)：HTTP 接口、幂等提交、任务状态、SSE 和恢复语义。
- [HTTP 契约源码](packages/contracts/src/index.ts)：字段类型与运行时校验的唯一来源。

## 目录与责任

```text
apps/web/                   React 界面、HTTP 客户端、事件流与主题
apps/server/                HTTP API、鉴权、任务调度、SQLite 存储与启动入口
apps/desktop/               Electron 窗口、系统集成、本地服务监管与代理
packages/contracts/         应用自己的请求、响应、事件和参数校验
packages/agent-runtime/     AgentEngine 接口、Pi 适配器、显式模拟引擎
scripts/                    后端构建和桌面运行时准备
```

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

模型不可用时按界面提示检查服务端配置；隔离与上下文说明见 [数据与配置归属](docs/architecture.md#数据与配置归属)。

## 桌面运行

```powershell
npm run dev
```

开发桌面读取项目根目录 `.env`；安装版本只继承启动环境。开发需要 Node，安装后的应用自带 Node，无需系统 Node 或全局 pi。

开发时后端源码变化会自动重建并重启应用，界面支持热更新。开发启动不执行类型检查，使用 `npm run check` 或 `npm run build` 验证类型。

设置 Pi 模型环境变量后再启动安装版本。桌面会话保存在 `userData/agent`，与独立后端的 `.data/` 分开，不自动同步。运行链路与关闭机制见 [整体架构](docs/architecture.md)。

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

接口使用 `/api/v1`，通过 HTTP 操作会话和任务，通过 SSE 接收快照与增量。请求幂等、取消、状态与断线恢复的完整约定见 [前后端协议](docs/protocol.md)；字段以 [contracts](packages/contracts/src/index.ts) 为准。

后端只绑定回环地址，检查 Host、Origin 和 Bearer。独立生产 Web 应使用有身份认证的反向代理提供 HTTPS、静态前端与 `/api` 路由，并配置明确的 `APP_ALLOWED_ORIGINS`；关闭代理的 SSE 缓冲。当前是单用户服务，没有账户、租户隔离、配额或公网直接暴露模式。

## 测试

测试随所属应用或包维护，各工作区拥有自己的 `test` 命令：

```text
apps/web/test/web.test.mjs
apps/server/test/server.test.mjs
apps/server/test/chat-service.test.mjs
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

打包应在目标操作系统及架构上运行。运行时和依赖准备机制见 [构建与交付](docs/architecture.md#构建与交付)。

`pack` 生成 `dist/win-unpacked/Learn Electron.exe`；`dist` 生成 NSIS 安装包。两者均不自动发布。应用 ID、名称、图标、签名和 GitHub 更新源继续由 `electron-builder.yml` 配置；发布前需要替换模板标识及仓库地址。

## 后续扩展位置

引擎、存储、工具和桌面能力的扩展位置见 [扩展与维护](docs/architecture.md#扩展与维护)。

MIT 许可证，保留模板原有版权声明，新增依赖遵循各自许可证。
