import { defineConfig } from 'electron-vite'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { mergeConfig, type Plugin } from 'vite'
import { rendererConfig } from './renderer.config.ts'

const run = promisify(execFile)

function backendDevBuild(): Plugin {
  return {
    name: 'desktop-backend-build',
    async buildStart() {
      for (const source of [
        './apps/server/src',
        './packages/agent-runtime/src',
        './packages/chatgpt-auth/src',
        './packages/contracts/src',
        './packages/model-connections/src',
        './apps/server/package.json',
        './packages/agent-runtime/package.json',
        './packages/chatgpt-auth/package.json',
        './scripts/build-server.mjs',
        './scripts/server-dependencies.mjs',
      ]) {
        this.addWatchFile(fileURLToPath(new URL(source, import.meta.url)))
      }
      // electron-vite restarts Electron after the main build completes.
      await run(process.execPath, ['scripts/build-server.mjs'], {
        cwd: fileURLToPath(new URL('.', import.meta.url)),
        windowsHide: true,
      })
    },
  }
}

export default defineConfig(({ command }) => ({
  main: {
    plugins: command === 'serve' ? [backendDevBuild()] : [],
    build: {
      sourcemap: command === 'serve' ? 'inline' : false,
      rolldownOptions: {
        input: fileURLToPath(new URL('./apps/desktop/main/index.ts', import.meta.url)),
      },
    },
  },
  preload: {
    build: {
      sourcemap: command === 'serve' ? 'inline' : false,
      // Sandboxed preload scripts must use CommonJS, even when the main process is ESM.
      rolldownOptions: {
        input: fileURLToPath(new URL('./apps/desktop/preload/index.ts', import.meta.url)),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: mergeConfig(rendererConfig(), {
    root: 'apps/web',
    build: {
      outDir: fileURLToPath(new URL('./out/renderer', import.meta.url)),
      rolldownOptions: { input: fileURLToPath(new URL('./apps/web/index.html', import.meta.url)) },
    },
  }),
}))
