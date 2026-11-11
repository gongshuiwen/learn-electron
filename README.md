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
packages/model-connections/ 与 SDK 无关的连接定义、模型元数据和纯校验
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

真实引擎默认使用 Pi。无需配置模型环境变量，启动后点击侧栏的 **设置**，在独立设置页（`#/settings`）完成接入：

1. 点击 **添加提供商**，选择 OpenAI、DeepSeek、Anthropic、Google Gemini、Ollama 或自定义预设。
2. 确认协议与 API 基地址，输入 API Key。OpenAI 兼容的本地服务可选择“无需认证”；高级设置支持自定义请求头。
3. 手动填写模型 ID，每行一个；也可以先保存并在选择器中查看连接，再点击“获取模型”。服务未提供目录时可继续使用手填模型。
4. 选择连接和模型，可点击“测试连接”验证实际生成，再点击“设为默认模型”，通过“返回聊天”继续。保存、浏览与测试都不会改变当前使用的模型；测试不写聊天历史，可能产生少量用量。

设置页集中管理提供商、模型与 ChatGPT 账号，支持刷新和浏览器前进后退。切换页面保留当前聊天草稿，正在生成的回复仍继续；正在生成的实例不能修改，其他实例仍可管理。

支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Google Generative AI 协议。填写 API 基地址并保留版本路径，例如 OpenAI 兼容网关的 `https://gateway.example.com/v1`；不填写完整的生成接口地址。模型 ID 不受 Pi 内置目录限制。未知模型默认上下文 32768、最大输出 4096，可在高级设置调整；修改长度时应用于所填模型，未修改时保留已有模型的元数据。协议兼容选项仅用于 Chat Completions 的已确认差异，其他私有协议或特殊签名认证需要执行适配器支持。

保存、切换与密钥更新即时生效，无需重启。编辑时密钥和自定义请求头留空表示保持原值；可明确清除密钥，或填写 `{}` 清除请求头。更换 API 地址或协议请添加新连接，以保留历史上下文的发送边界。生成、连接测试或授权进行中不能更改连接配置。ChatGPT 授权期间保留原模型选择，暂停该实例的新生成；其他实例仍可使用。成功登录后可设为默认模型，或返回聊天选择。默认选择保存失败时，原选择和已保存的账户凭据仍保留。

供应商品牌、实例和协议相互独立，同一供应商可保存多个实例。设置页通过实例列表展示账号和认证状态，选中后集中管理模型、测试与编辑，点击“设为默认模型”才更新新会话默认值。端点实例、模型、凭据与默认选择保存在后端数据目录的 `models/connections.json`，使用受保护的原子文件写入。聊天输入框旁可快捷选择供应商实例和模型，仅影响当前会话。空会话保留原 ID，已有消息时切换会新建对话并保留原历史与草稿；生成期间不可切换。配置与登录不会自动选用模型。前端提交凭据后不回显，不写浏览器存储；旧 `PI_AUTH_MODE`、`PI_PROVIDER`、`PI_MODEL` 和供应商 Key 环境变量不导入、不兜底。

添加 ChatGPT 账号时，在 **添加提供商** 中选择 **ChatGPT 订阅**，点击 **Continue with ChatGPT**，在系统浏览器授权使用 ChatGPT 计划。成功后选择账户和模型，设为默认模型或返回聊天选择；使用 OpenAI API Key 时请选择 OpenAI 预设。支持保存多个 ChatGPT 账户、逐个重新授权或退出，并通过“管理用量”查看 ChatGPT 设置。需要符合条件的账户及实际授予的计划使用权限；只有身份登录权限时不能调用模型。该连接保留 Pi 原生上下文与 Responses 流，模型目录取账户权限与 Pi 支持范围的交集；目录暂不可用时可点击“获取模型”。端点与多个 ChatGPT 账号可同时保存并供不同会话使用，不自动互相回退。

ChatGPT 凭证只保存在所选后端数据目录的 `chatgpt/connections.json`，按账户 ID 隔离；Windows 使用当前用户 ACL，其他平台使用所有者权限，文件原子替换。它与浏览器 Cookie、用户的 Codex/Pi 全局登录相互独立。退出某账户只清除其本地令牌并尝试撤销其远程授权，保留注册信息用于再次授权；只取消绑定该账号的活动任务，其他实例的任务不受影响。远程撤销未确认时界面会说明。不要提交、分享或在日志中输出凭证文件。

每个会话首次生成时绑定具体实例与模型，之后修改默认选择不会改变它；同一或不同供应商的多个实例可以在不同会话同时使用。需要更换已绑定会话的模型时新建会话。演示会话不会使用真实模型续聊。ChatGPT 登录用于模型授权，不是本地服务的多用户账户系统。官方适用范围与限制见 [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)。

浏览器回到“正在完成 ChatGPT 授权”仅说明收到了回调；返回应用确认“已授权 · 可使用 ChatGPT 计划”，再选用可用模型。授权期间刷新页面，可以恢复进度、重新打开登录或取消。当前版本使用 SQLite v4、模型连接 v4 和 ChatGPT 凭据 v2，不迁移旧版本数据；遇到旧格式时请保留原数据，使用新的数据目录重新配置。

浏览器可访问 OpenAI 而后端出现网络错误时，检查两者是否使用同一网络出口。后端统一按 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY` 路由 OAuth 与模型请求，不自动读取 Windows 的系统代理。需要代理时，在启动应用的 PowerShell 或后端 `.env` 中设置前两项，并设置 `NO_PROXY=localhost,127.0.0.1,::1` 保持本地通信直连，修改后重启。核对出口应在 Pi 初始化完成后进行。`403 unsupported_country_region_territory` 表示上游拒绝当前请求的地区，需确认实际出口符合 [OpenAI 官方支持范围](https://developers.openai.com/api/docs/supported-countries)。后端请求拒绝 HTTP 重定向，避免 API Key 和自定义凭据头被转发到其他地址；请直接填写最终 API 基地址。系统浏览器内的正常授权跳转不受影响。不要关闭 TLS 验证。

修改服务端口、数据目录、引擎模式或网络代理等运行环境配置后，重启对应的 server 或 desktop；访问令牌或代理地址变化时，也需重启 Web 开发服务。界面中的模型连接配置即时生效。

模型不可用时按界面提示检查模型连接、凭据和网络；隔离与上下文说明见 [数据与配置归属](docs/architecture.md#数据与配置归属)。

后端只绑定回环地址，检查 Host、Origin 和 Bearer。当前是单用户服务，没有账户、租户隔离、配额或公网直接暴露模式。生产 Web 部署见 [构建与交付](docs/build-and-delivery.md#独立-web-部署)。

## 桌面运行

```powershell
npm run dev
```

根目录的 `dev`、`build` 和 `preview` 默认面向桌面；独立 Web 和后端使用带 `:web`、`:server` 后缀的入口。全仓库静态检查和工作区测试分别使用 `npm run check`、`npm test`。

开发桌面读取项目根目录 `.env`；安装版本只继承运行环境，模型接入统一在界面配置。开发需要 Node，安装后的应用自带 Node，无需系统 Node 或全局 pi。

开发时后端源码变化会自动重建并重启应用，界面支持热更新。开发启动不执行类型检查，使用 `npm run check` 或 `npm run build` 验证类型。

桌面会话与模型连接保存在 `userData/agent`，与独立后端的 `.data/` 分开，各自授权，不自动同步。OAuth 使用后端的回环回调，浏览器必须与后端运行在同一机器。运行链路与关闭机制见 [整体架构](docs/architecture.md)。

排查启动或运行问题时，独立服务查看终端输出；桌面通过“打开日志目录”菜单查看 `userData/logs/main.log`。

MIT 许可证，保留模板原有版权声明，新增依赖遵循各自许可证。
