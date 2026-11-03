import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { Plugin, UserConfig } from 'vite'
import { fileURLToPath } from 'node:url'

function contentSecurityPolicy(): Plugin {
  return {
    name: 'renderer-content-security-policy',
    transformIndexHtml(html, context) {
      // React Fast Refresh and Vite's CSS updates need inline content in development.
      const development = Boolean(context.server)
      const policy = [
        "default-src 'self'",
        `script-src 'self'${development ? " 'unsafe-inline'" : ''}`,
        `style-src 'self'${development ? " 'unsafe-inline'" : ''}`,
        `connect-src 'self'${development ? ' app://desktop ws://localhost:* ws://127.0.0.1:*' : ''}`,
        "img-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'none'",
        "frame-src 'none'",
      ].join('; ')

      return html.replace('__CSP__', policy)
    },
  }
}

export function rendererConfig(): UserConfig {
  return {
    resolve: { alias: { '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)) } },
    plugins: [react(), tailwindcss(), contentSecurityPolicy()],
    server: { host: '127.0.0.1' },
    build: { minify: true },
  }
}
