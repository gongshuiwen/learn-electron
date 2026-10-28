# Learn Electron

Electron + TypeScript + React + Tailwind CSS 桌面应用基础项目，使用 electron-vite 管理本地开发、热更新和源码编译。

## 开始开发

需要 Node.js 22.13+（22.x）或 24+，推荐 Node.js 24 LTS，以及 npm。

```sh
npm ci
npm run dev
```

`npm start` 同样启动开发模式。命令会自动打开 Electron 窗口；渲染进程支持 React Fast Refresh，主进程和 preload 修改后会自动重启或刷新。使用 `Ctrl+C` 停止开发服务。

首次运行 `dev` 或 `preview` 时，`install-electron` 会下载 Electron 二进制文件；后续启动复用本地文件。Electron 新版本按需下载运行时，因此这里显式在启动前准备，兼容 electron-vite 的启动方式。

首页包含 React 计数器，以及通过 preload 和 IPC 读取应用版本的示例。桌面 API 需要在 Electron 窗口内使用。

## 常用命令

| 命令                | 用途                                                 |
| ------------------- | ---------------------------------------------------- |
| `npm run dev`       | 启动本地开发与热更新                                 |
| `npm run typecheck` | 分别检查 Node / Electron 和浏览器环境的类型          |
| `npm run lint`      | 检查 TypeScript、React Hooks 和 Fast Refresh 规则    |
| `npm run format`    | 使用 Prettier 格式化代码                             |
| `npm run check`     | 执行类型、lint 和格式检查                            |
| `npm run build`     | 检查类型并编译源码到 `out/`                          |
| `npm run preview`   | 在 Electron 中运行已有的 `out/` 产物（先执行 build） |

`build` 只生成本地运行所需的 JavaScript、HTML 和 CSS。本阶段未接入 Electron Forge、electron-builder、安装包制作、签名、自动更新或发布流程。

## 项目结构

```text
src/
  main/index.ts                  # Electron 主进程：窗口生命周期、IPC 处理
  preload/index.ts               # contextBridge：只暴露明确的桌面 API
  shared/ipc.ts                  # IPC 通道、请求返回值和桥接接口类型
  renderer/
    index.html                   # 页面入口
    src/
      main.tsx                   # React 入口
      App.tsx                    # 示例界面
      components/RuntimeInfo.tsx # 运行环境展示
      env.d.ts                   # window.electronAPI 类型声明
      styles.css                 # Tailwind CSS 入口和全局样式
electron.vite.config.ts           # 三个进程的开发及编译配置
tsconfig.base.json                # 共享的严格 TypeScript 配置
tsconfig.node.json                # 主进程、preload 与工具配置的类型环境
tsconfig.web.json                 # React 渲染进程的浏览器类型环境
```

## 开发约定

- 页面和组件放在 `src/renderer/src/`，样式直接使用 Tailwind 工具类。Tailwind 使用 `@tailwindcss/vite` 插件和 CSS 入口，无需额外的 PostCSS 或 Tailwind JavaScript 配置。
- 主进程采用 ESM；preload 编译为单个 CommonJS 文件，兼容 Electron 的沙箱模式。
- 窗口启用 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`。渲染进程通过 `window.electronAPI` 调用允许的接口，不直接访问 Node.js 或 `ipcRenderer`。
- 新增桌面能力时，在 `src/shared/ipc.ts` 定义接口，在主进程注册处理器，并通过 preload 暴露具体方法。主进程必须验证调用来源和传入参数。
- HTML 的 CSP 由 Vite 插件按环境注入：开发时允许 React Fast Refresh、样式热更新和本地 WebSocket；编译产物使用更严格的策略。
- 提交前运行 `npm run check` 和 `npm run build`。依赖使用 npm 管理，并提交 `package-lock.json`；`out/` 和类型检查缓存不入库。

## 参考文档

- [electron-vite 项目结构与开发](https://electron-vite.org/guide/dev)
- [Tailwind CSS 的 Vite 接入](https://tailwindcss.com/docs/installation/using-vite)
- [Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)
