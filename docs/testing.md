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
| 桌面启动与聊天链路           | `npm run test:smoke`                          |

CI 执行完整桌面集成测试。其他测试命令见 [根脚本](../package.json)与各工作区的 `package.json`。

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

自动化测试不覆盖真实提供商网络连接；页面恢复测试不验证操作系统原生崩溃事件投递。

## 交付验证

发布前需在 Windows 显式运行以下命令；该验证不在常规 `npm test` 或 CI 中：

```powershell
npm run test:packaged
```

该命令通过 `pretest:packaged` 准备 `win-unpacked` 应用，并复制到仓库外，验证无系统 Node 的运行、历史恢复、后台进程清理及生产 Pi 依赖的离线加载；NSIS 安装/卸载、签名和更新按任务需要另行验证。
