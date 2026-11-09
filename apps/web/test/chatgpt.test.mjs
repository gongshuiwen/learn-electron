import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { startServer } from '../../server/src/server.ts'
import { oauthFixture } from '../../server/test/helpers/chatgpt.mjs'

test(
  'browser recovers login after backend restart without reloading, chats through Pi and signs out',
  { timeout: 45_000 },
  async (t) => {
    const remote = await oauthFixture(t)
    remote.oauth.authorization = (params) =>
      `https://auth.openai.com/api/accounts/authorize?${params}`
    const originalFetch = globalThis.fetch
    t.mock.method(globalThis, 'fetch', (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      )
      return url.origin === 'https://api.openai.com'
        ? originalFetch(`${remote.issuer}${url.pathname}${url.search}`, init)
        : originalFetch(input, init)
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-browser-oauth-'))
    const options = {
      token: 'browser-oauth-service-token',
      dataDir,
      authMode: 'chatgpt',
      chatgptOAuth: remote.oauth,
    }
    let backend = await startServer(options)
    let web
    let browser
    t.after(async () => {
      await browser?.close()
      await web?.close()
      await backend.close()
      assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()))
      await rm(dataDir, { recursive: true, force: true })
    })
    web = await preview({
      configFile: false,
      root: fileURLToPath(new URL('../', import.meta.url)),
      build: { outDir: fileURLToPath(new URL('../../../out/web/', import.meta.url)) },
      preview: {
        port: 0,
        host: '127.0.0.1',
        proxy: {
          '/api': {
            target: backend.url,
            changeOrigin: true,
            configure(proxy) {
              proxy.on('proxyReq', (request) => {
                request.removeHeader('origin')
                request.setHeader('Authorization', 'Bearer browser-oauth-service-token')
              })
            },
          },
        },
      },
    })
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' })
    const context = await browser.newContext()
    context.setDefaultTimeout(10_000)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const authorizations = []
    await context.route('https://auth.openai.com/api/accounts/authorize?**', async (route) => {
      const params = new URL(route.request().url()).searchParams
      authorizations.push(params)
      const code = randomUUID()
      remote.codes.set(code, params)
      const clientId =
        params.get('client_id') === 'dynamic_agent_client'
          ? `oaiapp_${randomUUID()}`
          : params.get('client_id')
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html>
      <title>测试授权服务</title><p>允许 Pi Chat 使用测试账户的计划？</p>
      <form action="${params.get('redirect_uri')}" method="get">
      <input type="hidden" name="state" value="${params.get('state')}">
      <input type="hidden" name="code" value="${code}">
      <input type="hidden" name="client_id" value="${clientId}">
      <button>允许 Pi Chat</button></form>`,
      })
    })
    await page.goto(web.resolvedUrls.local[0])
    await page.getByRole('button', { name: 'Continue with ChatGPT' }).waitFor()
    assert.equal(
      await page.getByRole('textbox', { name: '发送消息', exact: true }).isDisabled(),
      true,
    )
    const popupEvent = context.waitForEvent('page')
    const loginResponse = page.waitForResponse((response) =>
      response.url().endsWith('/auth/chatgpt/login'),
    )
    await page.getByRole('button', { name: 'Continue with ChatGPT' }).click()
    assert.equal((await loginResponse).status(), 201)
    const popup = await popupEvent
    await page.reload()
    await page.getByRole('button', { name: '取消登录', exact: true }).waitFor()
    assert.equal(authorizations.length, 1)
    await popup.getByRole('button', { name: '允许 Pi Chat' }).click()
    await page.getByText('已连接 · 使用 ChatGPT 计划', { exact: true }).waitFor()
    await popup.close()
    await page.getByLabel('ChatGPT 模型').waitFor()
    await page.getByRole('button', { name: '知道了', exact: true }).click()
    await page.setViewportSize({ width: 700, height: 800 })
    await page.getByRole('button', { name: 'ChatGPT 连接设置' }).click()
    assert.equal(await page.getByLabel('ChatGPT 模型').isVisible(), true)
    await page.getByRole('button', { name: 'ChatGPT 连接设置' }).click()
    assert.equal(await page.getByLabel('ChatGPT 模型').isVisible(), false)
    const composerFits = await page
      .locator('.composer')
      .evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight)
    assert.equal(composerFits, true)
    await page.setViewportSize({ width: 1280, height: 900 })
    const input = page.getByRole('textbox', { name: '发送消息', exact: true })
    const draft = '你好，请记住这个问候'
    await input.fill(draft)
    const timeOrigin = await page.evaluate(() => performance.timeOrigin)
    const interruptedPopup = context.waitForEvent('page')
    const interruptedLogin = page.waitForResponse((response) =>
      response.url().endsWith('/auth/chatgpt/login'),
    )
    await page.getByRole('button', { name: '重新授权 ChatGPT', exact: true }).click()
    const pendingLogin = await (await interruptedLogin).json()
    await page.getByRole('button', { name: '取消登录', exact: true }).waitFor()
    await (await interruptedPopup).close()
    const missingLogin = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/auth/chatgpt/logins/${pendingLogin.id}`) &&
        response.status() === 404,
    )
    const port = Number(new URL(backend.url).port)
    await backend.close()
    backend = await startServer({ ...options, port })
    assert.equal((await (await missingLogin).json()).error.code, 'login_not_found')
    await page.getByText('登录请求已失效，请重新登录。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '取消登录', exact: true }).waitFor({ state: 'hidden' })
    assert.equal(await input.inputValue(), draft)
    assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin)
    const repeatPopup = context.waitForEvent('page')
    await page.getByRole('button', { name: '重新授权 ChatGPT', exact: true }).click()
    const repeat = await repeatPopup
    await repeat.getByRole('button', { name: '允许 Pi Chat' }).click()
    assert.notEqual(authorizations.at(-1).get('client_id'), 'dynamic_agent_client')
    assert.equal(
      authorizations.at(-1).get('ext_agent_host_id'),
      authorizations[0].get('ext_agent_host_id'),
    )
    await page.getByText('已连接 · 使用 ChatGPT 计划', { exact: true }).waitFor()
    await repeat.close()
    assert.equal(await input.inputValue(), draft)
    async function sendDraft(reply) {
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await page.getByText(reply, { exact: true }).waitFor()
      await page.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' })
      assert.equal(await page.getByRole('alert').count(), 0)
    }
    await sendDraft('你好，我记住了。')
    await input.fill('我刚才说了什么？')
    await sendDraft('你刚才说了你好。')
    assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin)
    assert.equal(remote.calls, 2)
    assert.match(JSON.stringify(remote.requests[1].body.input), /你好，请记住这个问候/)
    await page.reload()
    await page.getByText('你好，我记住了。', { exact: true }).waitFor()
    await page.getByText('你刚才说了你好。', { exact: true }).waitFor()
    const clientStorage = await page.evaluate(() => JSON.stringify({ ...localStorage }))
    assert.doesNotMatch(clientStorage, /plan-access|plan-refresh|idToken|refreshToken/)
    const addPopup = context.waitForEvent('page')
    const addRequest = page.waitForRequest((request) =>
      request.url().endsWith('/auth/chatgpt/login'),
    )
    await page.getByRole('button', { name: '添加连接', exact: true }).click()
    const added = await addPopup
    await added.getByRole('button', { name: '允许 Pi Chat' }).waitFor()
    assert.deepEqual((await addRequest).postDataJSON(), {})
    assert.equal(authorizations.at(-1).get('client_id'), 'dynamic_agent_client')
    await page.getByRole('button', { name: '取消登录', exact: true }).click()
    await added.close()
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.waitForFunction(() => window.document.querySelector('#message').disabled)
    assert.equal(remote.revoked.length, 1)
    remote.tokenError = { code: 'unsupported_country_region_territory' }
    remote.tokenErrorStatus = 403
    const deniedPopup = context.waitForEvent('page')
    await page.getByRole('button', { name: '重新授权 ChatGPT', exact: true }).click()
    const denied = await deniedPopup
    await denied.getByRole('button', { name: '允许 Pi Chat' }).waitFor()
    assert.notEqual(authorizations.at(-1).get('client_id'), 'dynamic_agent_client')
    await denied.getByRole('button', { name: '允许 Pi Chat' }).click()
    await page
      .getByRole('alert')
      .filter({ hasText: 'unsupported_country_region_territory' })
      .waitFor()
    assert.equal(
      await page.getByRole('textbox', { name: '发送消息', exact: true }).isDisabled(),
      true,
    )
    assert.equal(remote.calls, 2)
    assert.deepEqual(errors, [])
  },
)
