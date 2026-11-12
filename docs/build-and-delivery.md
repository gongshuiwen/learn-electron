# 构建与交付

以下命令均在仓库根目录执行；环境准备见 [README](../README.md#环境)。

## 构建命令与产物

| 命令                   | 用途与产物                                                          |
| ---------------------- | ------------------------------------------------------------------- |
| `npm run build:web`    | 只检查和构建前端，输出 `out/web`                                    |
| `npm run build:server` | 只检查和构建后端及 Runtime，输出独立启动入口 `out/server/index.mjs` |
| `npm run start:server` | 运行构建后的独立后端 `out/server/index.mjs`                         |
| `npm run build`        | 组合检查并生成桌面产物，前端输出 `out/renderer`                     |

## 后端构建

[build-server.mjs](../scripts/build-server.mjs) 打包工作区源码，在 `out/server` 生成独立启动入口 `index.mjs`、桌面入口 `desktop-child.mjs` 和程序化入口 `server.mjs`；Fastify、Pi 等第三方生产依赖保持外置，独立部署时需一并提供。

## 独立 Web 部署

独立生产 Web 的部署要求：

- 反向代理提供 HTTPS、静态前端与 `/api` 路由，并负责外部用户身份认证。
- 代理向本地后端转发请求时，注入 `Authorization: Bearer <APP_API_TOKEN>`，并将 `Host` 设为后端实际监听的地址与端口。
- 为后端配置明确的 `APP_ALLOWED_ORIGINS`。
- 关闭反向代理的 SSE 缓冲，使事件及时转发到客户端。

## 桌面运行时准备

根 [package.json](../package.json) 同时是 Electron 交付清单，因此保留与 desktop 一致的原生生产依赖。

[server-dependencies.mjs](../scripts/server-dependencies.mjs) 从工作区清单取得外部依赖，供构建和运行时准备共用。[prepare-runtime.mjs](../scripts/prepare-runtime.mjs) 复用根锁文件版本，为 `out/server` 通过 `npm ci` 安装依赖后用 `npm prune` 裁去其他工作区的包，并将当前 Node 二进制及其许可证放入 `out/runtime`。

## 桌面资源打包

[打包配置](../electron-builder.yml) 将 Node 与自包含的 server 分别放入 `resources/runtime`、`resources/server`，位于 ASAR 外，供独立 Node 访问。后端 `node_modules` 使用单独的资源映射，避免被打包器的目录过滤规则跳过。

## Windows 打包

打包应在目标操作系统及架构上运行。

```powershell
npm run pack
npm run dist
```

`pack` 生成 `dist/win-unpacked/Learn Electron.exe`；`dist` 生成 NSIS 安装包。两者均不自动发布。应用 ID、名称、图标、签名和 GitHub 更新源继续由 `electron-builder.yml` 配置；发布前需要替换模板标识及仓库地址。

桌面发布验证配套的前端、后端、Pi 与 Node 组合，具体要求见测试指南的[交付验证](testing.md#交付验证)。

## 开发构建

开发时由 [main 构建钩子](../electron.vite.config.ts) 监听后端、Runtime、连接核心和契约变化，先构建后端，再由 electron-vite 重启应用。
