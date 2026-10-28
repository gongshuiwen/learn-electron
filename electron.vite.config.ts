import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

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
        `connect-src 'self'${development ? ' ws://localhost:* ws://127.0.0.1:*' : ''}`,
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

export default defineConfig(({ command }) => ({
  main: {
    build: { sourcemap: command === 'serve' ? 'inline' : false },
  },
  preload: {
    build: {
      sourcemap: command === 'serve' ? 'inline' : false,
      // Sandboxed preload scripts must use CommonJS, even when the main process is ESM.
      rolldownOptions: {
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss(), contentSecurityPolicy()],
    server: { host: '127.0.0.1' },
    build: { minify: true },
  },
}))
