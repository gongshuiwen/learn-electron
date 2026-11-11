import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { startServer } from '../../server/src/server.ts'
import { ProtectedFile } from '../../server/src/protected-file.ts'
import { oauthFixture } from '../../server/test/helpers/chatgpt.mjs'

test(
  'browser recovers login after backend restart without reloading, chats through Pi and signs out',
  { timeout: 60_000 },
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
      chatgptOAuth: remote.oauth,
    }
    let backend = await startServer(options)
    let restarting = Promise.resolve()
    let web
    let browser
    t.after(async () => {
      await browser?.close()
      await web?.close()
      await restarting.catch(() => {})
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
    assert.equal(
      await page.getByRole('textbox', { name: '发送消息', exact: true }).isDisabled(),
      true,
    )
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '添加提供商', exact: true }).click()
    const form = page.getByRole('dialog', { name: '添加模型提供商' })
    await form.getByLabel('提供商预设').selectOption('chatgpt')
    const popupEvent = context.waitForEvent('page')
    const loginResponse = page.waitForResponse((response) =>
      response.url().endsWith('/auth/attempts'),
    )
    await form.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click()
    assert.equal((await loginResponse).status(), 201)
    const popup = await popupEvent
    await page.reload()
    await page.getByRole('button', { name: '取消登录', exact: true }).waitFor()
    assert.equal(authorizations.length, 1)
    await popup.getByRole('button', { name: '允许 Pi Chat' }).click()
    await page.getByText('已授权 · 可使用 ChatGPT 计划', { exact: true }).waitFor()
    const screenshotDir = fileURLToPath(new URL('../../../.cache/', import.meta.url))
    await mkdir(screenshotDir, { recursive: true })
    await page.screenshot({
      path: join(screenshotDir, 'chatgpt-account-settings.png'),
      fullPage: true,
    })
    await popup.close()
    await page.getByLabel('当前模型').waitFor()
    assert.equal(
      await page.evaluate(async () => (await (await fetch('/api/v1/meta')).json()).configured),
      false,
    )
    await page.getByRole('button', { name: '设为默认模型', exact: true }).click()
    await page.getByRole('button', { name: '知道了', exact: true }).click()
    await page.setViewportSize({ width: 700, height: 800 })
    assert.equal(
      await page.getByRole('button', { name: '管理用量', exact: true }).isVisible(),
      true,
    )
    await page.getByRole('link', { name: '返回聊天', exact: true }).click()
    const composerFits = await page
      .locator('.composer')
      .evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight)
    assert.equal(composerFits, true)
    await page.setViewportSize({ width: 1280, height: 900 })
    const input = page.getByRole('textbox', { name: '发送消息', exact: true })
    const draft = '你好，请记住这个问候'
    await input.fill(draft)
    const timeOrigin = await page.evaluate(() => performance.timeOrigin)
    await page.getByRole('link', { name: '设置', exact: true }).click()
    const interruptedPopup = context.waitForEvent('page')
    const interruptedLogin = page.waitForResponse((response) =>
      response.url().endsWith('/auth/attempts'),
    )
    await page.getByRole('button', { name: '重新授权 ChatGPT', exact: true }).click()
    const pendingLogin = await (await interruptedLogin).json()
    await page.getByRole('button', { name: '取消登录', exact: true }).waitFor()
    await page.getByText('ChatGPT · 授权中', { exact: true }).waitFor()
    await (await interruptedPopup).close()
    const missingLogin = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/model-auth-attempts/${pendingLogin.id}`) &&
        response.status() === 404,
      { timeout: 30_000 },
    )
    void missingLogin.catch(() => {})
    const port = Number(new URL(backend.url).port)
    restarting = (async () => {
      await backend.close()
      t.signal.throwIfAborted()
      backend = await startServer({ ...options, port })
      t.signal.throwIfAborted()
    })()
    await restarting
    assert.equal((await (await missingLogin).json()).error.code, 'login_not_found')
    await page.getByText('登录请求已失效，请重新登录。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '取消登录', exact: true }).waitFor({ state: 'hidden' })
    await page.getByRole('link', { name: '返回聊天', exact: true }).click()
    assert.equal(await input.inputValue(), draft)
    assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin)
    await page.getByRole('link', { name: '设置', exact: true }).click()
    const repeatPopup = context.waitForEvent('page')
    await page.getByRole('button', { name: '重新授权 ChatGPT', exact: true }).click()
    const repeat = await repeatPopup
    await repeat.getByRole('button', { name: '允许 Pi Chat' }).click()
    assert.notEqual(authorizations.at(-1).get('client_id'), 'dynamic_agent_client')
    assert.equal(
      authorizations.at(-1).get('ext_agent_host_id'),
      authorizations[0].get('ext_agent_host_id'),
    )
    await page.getByText('已授权 · 可使用 ChatGPT 计划', { exact: true }).waitFor()
    await repeat.close()
    await page.getByRole('link', { name: '返回聊天', exact: true }).click()
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
    const account = await page.evaluate(async () =>
      (await (await fetch('/api/v1/model-providers')).json()).instances.find(
        (instance) => instance.kind === 'chatgpt',
      ),
    )
    const pickerButton = page.getByRole('button', { name: '选择聊天模型', exact: true })
    assert.ok((await pickerButton.getAttribute('title')).includes(account.name))
    await pickerButton.click()
    const picker = page.getByRole('dialog', { name: '聊天模型选择', exact: true })
    await picker
      .getByLabel('聊天模型', { exact: true })
      .locator('option')
      .filter({ hasText: 'Fixture model' })
      .waitFor({ state: 'attached' })
    assert.equal(await picker.getByLabel('聊天模型', { exact: true }).inputValue(), remote.modelId)
    assert.equal(
      await picker.getByRole('button', { name: '使用并新建对话', exact: true }).isDisabled(),
      true,
    )
    assert.equal(
      remote.calls,
      2,
      'Opening the picker and browsing a ChatGPT account must not call the model',
    )
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'hidden' })
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '添加账号', exact: true }).click()
    assert.equal(await form.getByLabel('提供商预设').inputValue(), 'chatgpt')
    const addPopup = context.waitForEvent('page')
    const addRequest = page.waitForRequest((request) => request.url().endsWith('/auth/attempts'))
    await form.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click()
    const added = await addPopup
    await added.getByRole('button', { name: '允许 Pi Chat' }).waitFor()
    assert.equal((await addRequest).method(), 'POST')
    assert.equal(authorizations.at(-1).get('client_id'), 'dynamic_agent_client')
    await page.getByRole('button', { name: '取消登录', exact: true }).click()
    await added.close()
    await page.getByRole('button', { name: `选择 ChatGPT · ${account.name}`, exact: true }).click()
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('link', { name: '返回聊天', exact: true }).click()
    await page.waitForFunction(() => window.document.querySelector('#message').disabled)
    assert.equal(remote.revoked.length, 1)
    remote.tokenError = { code: 'unsupported_country_region_territory' }
    remote.tokenErrorStatus = 403
    await page.getByRole('link', { name: '设置', exact: true }).click()
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
    await page.getByRole('link', { name: '返回聊天', exact: true }).click()
    assert.equal(
      await page.getByRole('textbox', { name: '发送消息', exact: true }).isDisabled(),
      true,
    )
    assert.equal(remote.calls, 2)
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await page.getByText('新会话默认：', { exact: false }).waitFor()
    const save = ProtectedFile.prototype.save
    const failedSave = t.mock.method(ProtectedFile.prototype, 'save', function (value) {
      return value.version === 2 && !value.profiles.some(({ id }) => id === account.id)
        ? Promise.reject(new Error('injected account save failure'))
        : save.call(this, value)
    })
    await page.getByRole('button', { name: '删除连接', exact: true }).click()
    await page.getByRole('button', { name: '确认删除连接', exact: true }).click()
    await page.getByText('服务处理请求失败', { exact: true }).waitFor()
    await page.getByText('尚未设置默认模型。', { exact: false }).waitFor()
    assert.equal(
      await page.evaluate(
        async () => (await (await fetch('/api/v1/model-providers')).json()).defaultSelection,
      ),
      null,
    )
    failedSave.mock.restore()
    await page.getByRole('button', { name: '确认删除连接', exact: true }).click()
    await page
      .getByRole('button', { name: `选择 ChatGPT · ${account.name}`, exact: true })
      .waitFor({ state: 'hidden' })
    assert.deepEqual(errors, [])
  },
)
