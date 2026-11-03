import { defineConfig } from 'electron-vite'
import { fileURLToPath } from 'node:url'
import { mergeConfig } from 'vite'
import { rendererConfig } from './renderer.config.ts'

export default defineConfig(({ command }) => ({
  main: {
    build: {
      sourcemap: command === 'serve' ? 'inline' : false,
      rolldownOptions: {
        input: fileURLToPath(new URL('./electron/main/index.ts', import.meta.url)),
      },
    },
  },
  preload: {
    build: {
      sourcemap: command === 'serve' ? 'inline' : false,
      // Sandboxed preload scripts must use CommonJS, even when the main process is ESM.
      rolldownOptions: {
        input: fileURLToPath(new URL('./electron/preload/index.ts', import.meta.url)),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: mergeConfig(rendererConfig(), {
    root: '.',
    build: {
      rolldownOptions: { input: fileURLToPath(new URL('./index.html', import.meta.url)) },
    },
  }),
}))
