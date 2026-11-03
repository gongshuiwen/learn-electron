import { defineConfig, mergeConfig } from 'vite'
import { rendererConfig } from './renderer.config.ts'

export default defineConfig(
  mergeConfig(rendererConfig(), {
    base: './',
    build: { outDir: 'out/web', emptyOutDir: true },
  }),
)
