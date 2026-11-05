import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { protocol } from 'electron'
import type { Backend } from './backend'

export const DESKTOP_ORIGIN = 'app://desktop'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
])

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

export function registerDesktopProtocol(
  backend: Backend,
  rendererRoot: string,
  devURL?: string,
): void {
  const root = resolve(rendererRoot)
  const allowedOrigins = new Set([DESKTOP_ORIGIN])
  if (devURL) allowedOrigins.add(new URL(devURL).origin)

  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin')
    // Electron's initiatorOrigin is newer than some shipped declaration sets.
    const initiator = (request as Request & { initiatorOrigin?: string }).initiatorOrigin
    const cors = new Headers()
    if (origin && allowedOrigins.has(origin)) {
      cors.set('Access-Control-Allow-Origin', origin)
      cors.set('Vary', 'Origin')
      cors.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
      cors.set('Access-Control-Allow-Headers', 'Content-Type')
    }
    if (
      url.host !== 'desktop' ||
      (origin && !allowedOrigins.has(origin)) ||
      (initiator && !allowedOrigins.has(initiator))
    )
      return new Response('Forbidden', { status: 403 })

    if (url.pathname.startsWith('/api/')) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
      const headers = new Headers(request.headers)
      headers.delete('origin')
      headers.delete('host')
      headers.set('Authorization', `Bearer ${backend.token}`)
      try {
        const backendURL = backend.url
        if (!backendURL) throw new Error('Local server is unavailable')
        const response = await fetch(`${backendURL}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          ...(request.method === 'GET' || request.method === 'HEAD'
            ? {}
            : { body: await request.arrayBuffer() }),
          redirect: 'error',
          signal: request.signal,
        })
        const responseHeaders = new Headers(response.headers)
        for (const name of ['connection', 'transfer-encoding', 'keep-alive'])
          responseHeaders.delete(name)
        cors.forEach((value, name) => responseHeaders.set(name, value))
        return new Response(response.body, { status: response.status, headers: responseHeaders })
      } catch {
        cors.set('Content-Type', 'application/json')
        return new Response(
          JSON.stringify({
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: '本地服务暂不可用，请稍后重试；持续失败时请重新启动应用。',
            },
          }),
          { status: 503, headers: cors },
        )
      }
    }

    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
    const file = resolve(root, `.${decodeURIComponent(url.pathname)}`)
    if (!file.startsWith(`${root}${sep}`)) return new Response('Forbidden', { status: 403 })
    try {
      return new Response(await readFile(file), {
        headers: { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream' },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
