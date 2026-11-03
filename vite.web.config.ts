import { defineConfig, loadEnv, mergeConfig } from 'vite'
import type { ProxyOptions } from 'vite'
import { rendererConfig } from './renderer.config.ts'

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  const proxy: Record<string, ProxyOptions> = {
    '/api': {
      target: env.APP_SERVER_URL || 'http://127.0.0.1:4318',
      changeOrigin: true,
      headers: env.APP_API_TOKEN ? { Authorization: `Bearer ${env.APP_API_TOKEN}` } : {},
      configure(proxy) {
        // The proxy is the authenticated client. Browser origins are validated by Vite.
        proxy.on('proxyReq', (request) => request.removeHeader('origin'))
      },
    },
  }
  return mergeConfig(rendererConfig(), {
    root: 'apps/web',
    base: './',
    server: { proxy },
    preview: { proxy },
    build: { outDir: '../../out/web', emptyOutDir: true },
  })
})
