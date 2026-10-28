# Learn Electron

Electron + TypeScript + React + Tailwind CSS 桌面应用基础项目，使用 electron-vite 管理本地开发、热更新和源码编译。

## 使用此模板

1. 将项目复制到自己的仓库，修改 `package.json` 的 `name`、`version`、`description` 和 `author`，然后运行 `npm install --package-lock-only` 同步锁文件。
2. 修改 `src/renderer/index.html` 的页面标题，以及本 README 的项目名称和说明。
3. 替换 `src/renderer/src/App.tsx` 的示例界面；不需要时可删除 `components/RuntimeInfo.tsx`、`tests/example.test.mjs` 和 `test:example` 命令。保留 `ErrorBoundary` 和基础启动检查。
4. 按需扩展 `src/shared/ipc.ts`、主进程和 preload 的具体接口。基础测试使用 `getAppInfo` 检查 IPC，替换该接口时同步更新测试。
5. 模板采用 [MIT 许可证](LICENSE)，使用模板代码时保留原有版权和许可声明，可为新增代码补充自己的版权信息。

维护者如需启用 GitHub 的 **Use this template** 入口，先将稳定版本合入默认分支，再在仓库 Settings 中启用 **Template repository**。

## 开始开发

本地开发与 CI 统一使用 `.nvmrc` 中指定的 Node.js 24，以及随 Node.js 提供的 npm。支持 `.nvmrc` 的版本管理器可直接读取该文件；其他工具选择 Node.js 24 即可。`package.json` 的 `engines` 保留兼容范围，CI 验证 Node.js 24。

```sh
npm ci
npm run dev
```

`npm start` 同样启动开发模式。命令会自动打开 Electron 窗口；渲染进程支持 React Fast Refresh，主进程和 preload 修改后会自动重启或刷新。使用 `Ctrl+C` 停止开发服务。

首次运行 `dev` 或 `preview` 时，`install-electron` 会下载 Electron 二进制文件；后续启动复用本地文件。Electron 新版本按需下载运行时，因此这里显式在启动前准备，兼容 electron-vite 的启动方式。

首页包含 React 计数器，以及通过 preload 和 IPC 读取应用版本的示例。桌面 API 需要在 Electron 窗口内使用。

正常关闭窗口时，将普通窗口的位置、大小和最大化状态保存到应用 `userData` 目录的 `window-state.json`，下次启动自动恢复，不记忆最小化状态。恢复时会根据当前显示器工作区调整窗口，避免窗口落在屏幕外；状态文件缺失或损坏时使用默认值。删除该文件即可重置。强制结束进程时不保证保存本次调整。

## 常用命令

| 命令                   | 用途                                                 |
| ---------------------- | ---------------------------------------------------- |
| `npm run dev`          | 启动本地开发与热更新                                 |
| `npm run typecheck`    | 分别检查 Node / Electron 和浏览器环境的类型          |
| `npm run lint`         | 检查类型感知规则、React Hooks 和 Fast Refresh 规则   |
| `npm run format`       | 使用 Prettier 格式化代码                             |
| `npm run check`        | 执行类型、lint 和格式检查                            |
| `npm run build`        | 检查类型并编译源码到 `out/`                          |
| `npm run preview`      | 在 Electron 中运行已有的 `out/` 产物（先执行 build） |
| `npm run test:smoke`   | 编译并运行 Electron 启动回归检查                     |
| `npm run test:example` | 编译并检查示例页面的计数器与应用信息交互             |

`build` 只生成本地运行所需的 JavaScript、HTML 和 CSS。本阶段未接入 Electron Forge、electron-builder、安装包制作、签名、自动更新或发布流程。

## 调试与检查

在 VS Code 的运行和调试面板选择 **Electron: All**，按 F5 同时调试主进程、React 和 preload。配置复用 `npm run dev`，并为渲染进程调试使用本地端口 `9222`。也可以单独启动 **Electron: Main**。调试 preload 的初始执行时，在调试器连接后设置断点并重新加载窗口。

开发模式为主进程和 preload 生成内联 source map，生产编译不生成 source map，并压缩渲染进程代码。普通 `npm run dev` 不开启远程调试端口。

`npm run test:smoke` 使用 Node 自带测试运行器和 `playwright-core` 驱动本项目的 Electron，无需下载额外浏览器。检查页面挂载、IPC、隔离设置、hash 路由与刷新，以及启动失败退出码，不依赖示例页面文案。测试使用临时用户目录，结束后关闭窗口并清理。

CI 配置覆盖 Windows、macOS 和 Ubuntu 24.04，统一从 `.nvmrc` 读取 Node.js 版本，执行依赖安装、lint、格式检查和启动检查；类型检查与编译包含在启动检查命令中。Linux 使用 runner 自带的 Xvfb 提供虚拟显示，并为 Electron 的 `chrome-sandbox` 设置所需权限，保持沙箱开启。

同一 Git 引用的新检查会取消尚未完成的旧检查，避免连续推送重复占用 runner。

`npm run test:example` 单独检查示例页面交互，不作为基础 CI 的依赖。替换首页时，可同步修改或删除 `tests/example.test.mjs` 和对应的 npm 命令；保留基础启动检查。

React 渲染错误由错误边界显示重新加载入口；异步事件错误仍由调用方处理。主进程启动失败会输出错误并以状态码 `1` 退出。

## 项目结构

```text
src/
  main/index.ts                  # Electron 主进程：窗口生命周期、IPC 处理
  main/window-state.ts           # 窗口状态保存与恢复
  preload/index.ts               # contextBridge：只暴露明确的桌面 API
  shared/ipc.ts                  # IPC 通道、请求返回值和桥接接口类型
  renderer/
    index.html                   # 页面入口
    src/
      main.tsx                   # React 入口
      App.tsx                    # 示例界面
      components/RuntimeInfo.tsx # 运行环境展示
      components/ErrorBoundary.tsx # React 渲染错误提示
      env.d.ts                   # window.electronAPI 类型声明
      styles.css                 # Tailwind CSS 入口和全局样式
electron.vite.config.ts           # 三个进程的开发及编译配置
tsconfig.base.json                # 共享的严格 TypeScript 配置
tsconfig.node.json                # 主进程、preload 与工具配置的类型环境
tsconfig.web.json                 # React 渲染进程的浏览器类型环境
tests/smoke.test.mjs              # 关键启动流程回归检查
tests/example.test.mjs            # 可随示例页面替换或删除的交互检查
```

## 开发约定

- 页面和组件放在 `src/renderer/src/`，样式直接使用 Tailwind 工具类。Tailwind 使用 `@tailwindcss/vite` 插件和 CSS 入口，无需额外的 PostCSS 或 Tailwind JavaScript 配置。
- 主进程采用 ESM；preload 编译为单个 CommonJS 文件，兼容 Electron 的沙箱模式。
- 窗口启用 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`。渲染进程通过 `window.electronAPI` 调用允许的接口，不直接访问 Node.js 或 `ipcRenderer`。
- 默认拒绝浏览器权限检查和请求。需要通知、摄像头等能力时，在主进程的 `setPermissionCheckHandler` 和 `setPermissionRequestHandler` 中按具体权限与来源放行，并同步调整相关测试。
- 新增桌面能力时，在 `src/shared/ipc.ts` 定义接口，在主进程注册处理器，并通过 preload 暴露具体方法。当前只读接口校验调用方的窗口主页面和 URL，返回值与主进程共享 `AppInfo` 类型。未来接收用户输入或外部数据时，再按实际数据添加运行时校验。
- HTML 的 CSP 由 Vite 插件按环境注入：开发时允许 React Fast Refresh、样式热更新和本地 WebSocket；编译产物使用更严格的策略。
- 提交前运行 `npm run check` 和 `npm run test:smoke`（已包含 build）。依赖使用 npm 管理，并提交 `package-lock.json`；`out/` 和类型检查缓存不入库。
- 锁文件使用 npm 官方 registry 的下载地址。需要镜像时，通过本机 npm registry 配置选择，无需在模板中固定镜像地址。修改示例页面后，还应运行 `npm run test:example`。

## 参考文档

- [electron-vite 项目结构与开发](https://electron-vite.org/guide/dev)
- [Tailwind CSS 的 Vite 接入](https://tailwindcss.com/docs/installation/using-vite)
- [Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)
- [electron-vite 调试](https://electron-vite.org/guide/debugging)
- [typescript-eslint 类型感知检查](https://typescript-eslint.io/getting-started/typed-linting/)
- [Playwright Electron API](https://playwright.dev/docs/api/class-electron)
