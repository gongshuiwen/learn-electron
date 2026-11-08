# Pi Chat · Web + Desktop

React 前端、独立 Node 后端与 Electron 桌面集成组成的单用户聊天应用。三端可以分别启动、构建和测试；桌面与浏览器共用 HTTP + SSE 协议。Pi 被封装为可替换的 AgentEngine，首版仅提供聊天，不开放文件、命令或第三方扩展。

## 项目文档

- [整体架构](docs/architecture.md)：模块与依赖、运行路径、数据归属和生命周期。
- [构建与交付](docs/build-and-delivery.md)：构建命令与产物、生产 Web 部署和 Windows 打包。
- [前后端协议](docs/protocol.md)：HTTP 接口、幂等提交、任务状态、SSE 和恢复语义。
- [测试指南](docs/testing.md)：测试命令、构建准备、覆盖范围与交付验证。
- [HTTP 契约源码](packages/contracts/src/index.ts)：字段类型与运行时校验的唯一来源。
- [扩展与维护](docs/architecture.md#扩展与维护)：引擎、存储、工具和桌面能力的扩展位置。

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

也可以使用 `npm run dev -w @learn-electron/web` 等工作区命令。

后端默认监听 `127.0.0.1:4318`。Vite 将 `/api` 转发给后端，在服务端注入 `.env` 中的访问令牌，令牌和模型 API key 都不会进入前端构建。修改 `APP_PORT` 时，需同步设置 `APP_SERVER_URL` 指向新的后端地址。

离线演示可设置 `APP_ENGINE=mock`，即使配置了真实密钥，也只返回模拟回复；真实引擎失败时不会自动切换到 mock。

真实 Pi 模式使用 `APP_ENGINE=pi`。以 DeepSeek 为例配置 `PI_PROVIDER=deepseek` 和 `DEEPSEEK_API_KEY`，`PI_MODEL` 可填写 Pi 模型目录中的 ID；留空时选择该提供商有凭据的可用模型。其他提供商使用 Pi 对应的环境变量。模型与密钥统一由服务端管理，首版不提供浏览器密钥设置页。

修改 `.env`、模型凭据或引擎模式后，重启对应的 server 或 desktop；访问令牌或代理地址变化时，也需重启 Web 开发服务。源码监听不代表配置热加载。

模型不可用时按界面提示检查服务端配置；隔离与上下文说明见 [数据与配置归属](docs/architecture.md#数据与配置归属)。

后端只绑定回环地址，检查 Host、Origin 和 Bearer。当前是单用户服务，没有账户、租户隔离、配额或公网直接暴露模式。生产 Web 部署见 [构建与交付](docs/build-and-delivery.md#独立-web-部署)。

## 桌面运行

```powershell
npm run dev
```

开发桌面读取项目根目录 `.env`；安装版本只继承启动环境，设置 Pi 模型环境变量后再启动。开发需要 Node，安装后的应用自带 Node，无需系统 Node 或全局 pi。

开发时后端源码变化会自动重建并重启应用，界面支持热更新。开发启动不执行类型检查，使用 `npm run check` 或 `npm run build` 验证类型。

桌面会话保存在 `userData/agent`，与独立后端的 `.data/` 分开，不自动同步。运行链路与关闭机制见 [整体架构](docs/architecture.md)。

排查启动或运行问题时，独立服务查看终端输出；桌面通过“打开日志目录”菜单查看 `userData/logs/main.log`。

MIT 许可证，保留模板原有版权声明，新增依赖遵循各自许可证。
