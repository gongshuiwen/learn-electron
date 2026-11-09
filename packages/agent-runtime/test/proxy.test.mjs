import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

test(
  'Pi initialization preserves environment proxy routing and loopback bypass',
  { timeout: 30_000 },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-proxy-'))
    const sockets = new Set()
    let proxied = 0
    let bypassed = 0
    const reply = (response, text) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.end(text)
    }
    const tunnel = createServer((_request, response) => reply(response, 'proxy'))
    const proxy = createServer((_request, response) => {
      proxied++
      reply(response, 'proxy')
    })
    // Node's built-in proxy tunnels HTTP; Undici 8 can send absolute-form HTTP.
    proxy.on('connect', (_request, socket, head) => {
      proxied++
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) socket.unshift(head)
      tunnel.emit('connection', socket)
    })
    proxy.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    const local = createServer((_request, response) => {
      bypassed++
      reply(response, 'loopback')
    })
    t.after(async () => {
      for (const socket of sockets) socket.destroy()
      await Promise.all([proxy, local].map((server) => new Promise((done) => server.close(done))))
      assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()))
      await rm(dataDir, { recursive: true, force: true })
    })
    await Promise.all(
      [proxy, local].map((server) => new Promise((done) => server.listen(0, '127.0.0.1', done))),
    )
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
    const source = `
    import assert from 'node:assert/strict'
    const remote = 'http://proxy-route.invalid/probe'
    const read = async (url) => (await fetch(url, { signal: AbortSignal.timeout(5000) })).text()
    await assert.doesNotReject(async () => assert.equal(await read(remote), 'proxy'), 'proxy must work before Pi initialization')
    const { createPiEngine } = await import(${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)})
    const engine = await createPiEngine({ dataDir: process.env.PI_TEST_DATA_DIR })
    try {
      await assert.doesNotReject(async () => assert.equal(await read(remote), 'proxy'), 'Pi initialization must preserve the proxy')
      assert.equal(await read(process.env.PI_TEST_LOCAL_URL), 'loopback')
    } finally { await engine.close() }
  `
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
      timeout: 25_000,
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        NO_PROXY: 'localhost,127.0.0.1,::1',
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        no_proxy: 'localhost,127.0.0.1,::1',
        PI_TEST_DATA_DIR: dataDir,
        PI_TEST_LOCAL_URL: `http://127.0.0.1:${local.address().port}/health`,
      },
    })
    assert.equal(proxied, 2)
    assert.equal(bypassed, 1)
  },
)
