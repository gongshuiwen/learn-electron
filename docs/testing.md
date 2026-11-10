# 测试指南

以下命令均在仓库根目录执行；环境安装见 [README](../README.md#环境)。自动化测试不需要真实模型密钥。

Web 界面测试使用 Playwright 和本机 Chrome，可用 `PLAYWRIGHT_CHANNEL=msedge` 切换 Edge。

## 日常验证

测试随所属应用或包维护，按改动影响选择工作区或目标用例：

| 验证范围                     | 命令                                          |
| ---------------------------- | --------------------------------------------- |
| 指定工作区（以 server 为例） | `npm test --workspace @learn-electron/server` |
| 全部工作区测试               | `npm test`                                    |
| 全仓库静态检查               | `npm run check`                               |
| 桌面冒烟与完整集成测试       | `npm run test:desktop`                        |
| 桌面启动与聊天链路           | `npm run test:desktop:smoke`                  |

CI 使用 `npm run test:desktop` 执行桌面冒烟与完整集成测试。根目录的桌面测试入口统一使用 `test:desktop` 前缀，转发到桌面工作区的 `test`、`test:smoke` 和 `test:packaged`；工作区的准备钩子会自动执行。其他测试命令见 [根脚本](../package.json)与各工作区的 `package.json`。

## 单文件测试

通过 npm 测试脚本运行时，已声明的 `pretest` 等准备步骤会自动执行；直接运行 `node --test` 会跳过这些步骤。

桌面和 Web 界面测试需要与当前源码匹配的构建产物，单文件运行前先执行所属工作区的 `pretest`。后端、contracts 和 Runtime 测试不依赖桌面产物。

桌面单文件测试示例：

```powershell
npm run pretest --workspace @learn-electron/desktop
node --test --test-concurrency=1 apps/desktop/test/integration/lifecycle.test.mjs
```

构建输入未变时可以复用产物；变更后重新准备，避免用旧构建验证新源码。桌面测试按文件串行执行。

## 覆盖范围

| 层次      | 主要验证内容                           |
| --------- | -------------------------------------- |
| Web       | HTTP 客户端、浏览器界面与模拟 API 交互 |
| 后端      | HTTP/SSE 与 SQLite                     |
| contracts | 协议校验                               |
| Pi 适配   | 离线验证真实 session 与上下文持久化    |
| 桌面集成  | 真实本地后端与 mock 引擎的集成链路     |

ChatGPT 测试使用本地 OAuth/Responses 服务及真正签名的 ID token，不读取用户凭证或访问真实模型。后端覆盖 JWKS 身份校验、注册复用、权限不足、取消/超时、令牌轮换与账号上下文归属；HTTP 集成覆盖真实 Pi、SSE、重启续聊和失败不回退 API Key。Web 集成复用真实浏览器、后端及 Pi，在授权进行中于同一端口关闭并重建后端，验证页面不刷新、草稿保留、旧登录返回 `404 login_not_found` 后可重新授权，并直接发送草稿完成两轮上下文聊天；同一用例保留授权过程中刷新恢复、聊天历史重载与退出的检查。桌面测试验证受限浏览器 IPC 和 PUT 代理。Web 测试入口使用 `tsx` 以加载集成测试中的后端 TypeScript。

Web 登录恢复回归使用模拟 HTTP 响应，分别验证轮询、取消遇到 `404 login_not_found` 后结束旧尝试并直接重新登录，以及临时错误时保留进行中的登录；浏览器与后端的集成用例同时验证添加连接与重新授权分别使用新注册和已保存的连接。

Pi 代理回归使用独立 Node 进程和真实本地 HTTP 代理，验证 SDK 初始化前后都经过环境代理，以及 `NO_PROXY` 对回环请求的绕过；不替换 `fetch` 或访问外网。

自动化测试不覆盖真实提供商网络连接；页面恢复测试不验证操作系统原生崩溃事件投递。

真实账户验收使用 `PI_AUTH_MODE=chatgpt`：在系统浏览器授权计划使用，确认账户和模型，连续发送两轮消息，重启应用后续聊，查看 ChatGPT 用量设置，再验证退出和重新授权。检查真实上游成功前，不将模拟授权测试视为订阅可用性的证明。网络、账户/工作区政策及上游权限失败应记录实际状态，不关闭 TLS、绕过站点验证或改用 API Key。

## 交付验证

发布前需在 Windows 显式运行以下命令；该验证不在常规 `npm test` 或 CI 中：

```powershell
npm run test:desktop:packaged
```

该命令通过桌面工作区的 `pretest:packaged` 准备 `win-unpacked` 应用，并复制到仓库外，验证无系统 Node 的运行、历史恢复、后台进程清理、生产 Pi 依赖的离线加载，以及 ChatGPT 模式的 `jose`、Windows 凭证目录权限和登录入口；NSIS 安装/卸载、签名和更新按任务需要另行验证。
