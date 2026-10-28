# Learn Electron

Electron + TypeScript + React + Tailwind CSS 桌面应用基础项目，使用 electron-vite 管理本地开发、热更新和源码编译，使用 electron-builder 打包应用。

## 使用此模板

1. 将项目复制到自己的仓库，修改 `package.json` 的 `name`、`version`、`description` 和 `author`，然后运行 `npm install --package-lock-only` 同步锁文件。
2. 修改 `src/renderer/index.html` 的页面标题、`electron-builder.yml` 的 `appId`、`productName` 和 `publish` 仓库，以及本 README 的项目名称和说明。`appId` 应使用自己的唯一标识，发布后保持稳定。
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

同一用户数据目录只运行一个应用实例。重复启动会退出新进程，并显示、恢复和聚焦已有窗口；已有进程没有窗口时会重新创建。使用 Electron 原生单实例锁，开发模式同样生效，测试通过独立的临时用户目录隔离。

窗口状态使用独立的 `electron-store` 实例，保存到应用 `userData` 目录的 `window-state.json`。正常关闭窗口时保存普通窗口的位置、大小和最大化状态，下次启动自动恢复，不记忆最小化状态。恢复时会根据当前显示器工作区调整窗口，避免窗口落在屏幕外；默认值、Schema 校验和损坏配置重置由库处理。删除该文件即可重置。强制结束进程时不保证保存本次调整。

首页的主题选择支持跟随系统、浅色和深色，选择后立即保存到 `userData/settings.json`。启动时先恢复主题，再创建窗口；配置缺失或损坏时跟随系统。页面通过 Tailwind 的 `dark:` 样式响应 Electron 原生配色，无需额外的主题状态库或事件桥接。保存失败时保留原主题并显示错误提示。

应用设置使用 [electron-store](https://github.com/sindresorhus/electron-store)，仅在主进程的 `settings.ts` 中创建存储实例，目前只包含 `{ "theme": "system" }`。Schema 定义允许的值和默认值，缺失字段自动补齐；`clearInvalidConfig` 在 JSON 损坏或 Schema 校验失败时将配置重置为默认值并写回。文件读写和原子保存由库处理，写入失败仍通过 IPC 显示提示。窗口位置仍保存在独立的 `window-state.json` 中。

## 常用命令

| 命令                   | 用途                                                 |
| ---------------------- | ---------------------------------------------------- |
| `npm run dev`          | 启动本地开发与热更新                                 |
| `npm run typecheck`    | 分别检查 Node / Electron 和浏览器环境的类型          |
| `npm run lint`         | 检查类型感知规则、React Hooks 和 Fast Refresh 规则   |
| `npm run format`       | 使用 Prettier 格式化代码                             |
| `npm run check`        | 执行类型、lint 和格式检查                            |
| `npm run build`        | 检查类型并编译源码到 `out/`                          |
| `npm run pack`         | 编译并生成当前平台的可运行应用目录到 `dist/`         |
| `npm run dist`         | 编译并生成 Windows NSIS 安装包到 `dist/`             |
| `npm run preview`      | 在 Electron 中运行已有的 `out/` 产物（先执行 build） |
| `npm run test:smoke`   | 编译并运行 Electron 启动回归检查                     |
| `npm run test:example` | 编译并检查示例页面的计数器与应用信息交互             |

`build` 只编译源码；`pack` 和 `dist` 会先执行 `build`，再由 electron-builder 打包 Electron 运行时和应用。两个打包命令均关闭自动发布。

## 打包应用

在 Windows 上运行：

```sh
npm run pack
npm run dist
```

`pack` 生成 `dist/win-unpacked/Learn Electron.exe`，可直接运行，但分发时需要保留整个 `win-unpacked` 目录。`dist` 生成 `dist/Learn Electron Setup <版本>.exe`，使用 NSIS 默认的当前用户安装方式。

配置集中在 `electron-builder.yml`，指定应用标识、名称、输出目录、应用文件、Windows 安装包格式和 GitHub 更新源。应用文件包含 `out/` 和 `LICENSE`，electron-builder 自动加入 `package.json` 及生产依赖；源码、测试和开发工具不会作为应用文件打包。沿用默认 ASAR 归档与 Electron 图标。

首次打包需要下载 Electron 和打包工具，后续复用缓存。下载源可通过本机环境变量 `ELECTRON_MIRROR` 和 `ELECTRON_BUILDER_BINARIES_MIRROR` 调整。当前先支持 Windows 安装包，macOS / Linux 安装包、代码签名和自动发布流水线按需补充。`dist/` 已从 Git、lint 和格式检查中排除。

## 自动更新

Windows 打包版本在窗口创建后通过 `electron-updater` 检查一次 [GitHub Releases](https://github.com/gongshuiwen/learn-electron/releases)。发现新版本时用原生弹窗询问是否下载，下载完成后再询问是否重启安装；选择稍后安装不会在退出时自动安装，下次启动重新检查并复用有效下载缓存。开发模式及其他平台跳过检查。检查失败仅写入现有日志，下载失败显示提示，不影响正常使用。

发布新版本：

1. 更新 `package.json` 的版本号，并运行 `npm install --package-lock-only` 同步锁文件。
2. 运行 `npm run dist`，将本次生成的安装包 `.exe`、对应 `.exe.blockmap` 和 `latest.yml` 一起上传到 GitHub Release 草稿。
3. 确认标签为 `v<版本号>`、对应本次构建的提交，附件齐全后发布为正式 Release（不勾选预发布）。客户端无需 GitHub Token。

`publish` 配置让 electron-builder 生成客户端使用的 `app-update.yml`；`--publish never` 仍阻止构建命令自动上传文件。首次使用需要手动安装包含更新功能的版本，已有旧版无法凭空获得更新能力。验证更新应安装较低版本，再发布更高版本，检查下载、重启安装以及主题和窗口设置是否保留；仅运行 `win-unpacked` 不能替代安装升级验证。

## 调试与检查

在 VS Code 的运行和调试面板选择 **Electron: All**，按 F5 同时调试主进程、React 和 preload。配置复用 `npm run dev`，并为渲染进程调试使用本地端口 `9222`。也可以单独启动 **Electron: Main**。调试 preload 的初始执行时，在调试器连接后设置断点并重新加载窗口。

开发模式为主进程和 preload 生成内联 source map，生产编译不生成 source map，并压缩渲染进程代码。普通 `npm run dev` 不开启远程调试端口。

`npm run test:smoke` 使用 Node 自带测试运行器和 `playwright-core` 驱动本项目的 Electron，无需下载额外浏览器。检查页面挂载、IPC、隔离设置、hash 路由与刷新，以及启动失败退出码，不依赖示例页面文案。测试使用临时用户目录，结束后关闭窗口并清理。

CI 配置覆盖 Windows、macOS 和 Ubuntu 24.04，统一从 `.nvmrc` 读取 Node.js 版本，执行依赖安装、lint、格式检查和启动检查；类型检查与编译包含在启动检查命令中。Linux 使用 runner 自带的 Xvfb 提供虚拟显示，并为 Electron 的 `chrome-sandbox` 设置所需权限，保持沙箱开启。

同一 Git 引用的新检查会取消尚未完成的旧检查，避免连续推送重复占用 runner。

`npm run test:example` 单独检查示例页面交互，不作为基础 CI 的依赖。替换首页时，可同步修改或删除 `tests/example.test.mjs` 和对应的 npm 命令；保留基础启动检查。

React 渲染错误由错误边界显示重新加载入口；异步事件错误仍由调用方处理。主进程使用 [electron-log](https://github.com/megahertz/electron-log) 将启动版本、启动错误和窗口状态保存警告输出到控制台及 `userData/logs/main.log`，沿用库默认的 1 MiB 文件轮转（旧日志为 `main.old.log`）。启动失败会记录错误堆栈并以状态码 `1` 退出。仅接入主进程，未替换全局 `console` 或启用自动异常捕获。

## 项目结构

```text
src/
  main/index.ts                  # Electron 主进程：窗口生命周期、IPC 处理
  main/window-state.ts           # 独立窗口状态存储与屏幕边界调整
  main/theme.ts                  # 主题偏好与窗口背景
  main/settings.ts               # electron-store 实例、类型和 Schema
  main/updater.ts                # GitHub 更新检查、下载与原生安装提示
  preload/index.ts               # contextBridge：只暴露明确的桌面 API
  shared/ipc.ts                  # IPC 通道、请求返回值和桥接接口类型
  renderer/
    index.html                   # 页面入口
    src/
      main.tsx                   # React 入口
      App.tsx                    # 示例界面
      components/RuntimeInfo.tsx # 运行环境展示
      components/ThemeSelect.tsx # 可复用的主题选择控件
      components/ErrorBoundary.tsx # React 渲染错误提示
      env.d.ts                   # window.electronAPI 类型声明
      styles.css                 # Tailwind CSS 入口和全局样式
electron.vite.config.ts           # 三个进程的开发及编译配置
electron-builder.yml              # 应用打包与 Windows 安装包配置
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
- 新增桌面能力时，在 `src/shared/ipc.ts` 定义接口，在主进程注册处理器，并通过 preload 暴露具体方法。所有 IPC 接口校验调用方的窗口主页面和 URL；`getTheme` / `setTheme` 读取与保存主题，主进程只接受 `system`、`light`、`dark` 三种值。其他用户输入或外部数据按实际需要添加运行时校验。
- 新增实际设置时，在 `settings.ts` 的 `AppSettings` 和 Schema 中添加字段及默认值，通过对应的具体 IPC 接口更新；不向页面开放任意文件路径或任意键值写入，也不在 preload 或渲染进程导入 `electron-store`。
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
