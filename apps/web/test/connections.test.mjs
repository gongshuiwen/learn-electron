import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { startServer } from '../../server/src/server.ts'
import { modelProvider } from '../../server/test/helpers/model-provider.mjs'

test(
  'browser configures a custom provider, probes and chats without restart, preserves secrets on edit and restores selection',
  { timeout: 60_000 },
  async (t) => {
    const remote = await modelProvider(t)
    const dataDir = await mkdtemp(join(tmpdir(), 'learn-electron-browser-connections-'))
    const backend = await startServer({ token: 'browser-connections-token', dataDir })
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
                request.setHeader('Authorization', 'Bearer browser-connections-token')
              })
            },
          },
        },
      },
    })
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.setDefaultTimeout(10_000)
    const errors = []
    let connectionReads = 0
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      if (
        new URL(request.url()).pathname === '/api/v1/model-providers' &&
        request.method() === 'GET'
      )
        connectionReads++
    })
    await page.goto(web.resolvedUrls.local[0])
    const composer = page.getByRole('textbox', { name: '发送消息', exact: true })
    assert.equal(await composer.isDisabled(), true)
    assert.equal(connectionReads, 0, 'Chat does not load model configuration')
    assert.equal(await page.getByRole('region', { name: '模型设置', exact: true }).count(), 0)
    await page.getByRole('link', { name: '打开设置', exact: true }).click()
    await page.getByRole('heading', { name: '设置', exact: true }).waitFor()
    await page.getByRole('navigation', { name: '供应商实例', exact: true }).waitFor()
    await page.getByText('还没有供应商', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Continue with ChatGPT' }).count(), 0)
    assert.equal(connectionReads, 1, 'One initial request provides all connection state')
    const screenshotDir = fileURLToPath(new URL('../../../.cache/', import.meta.url))
    await mkdir(screenshotDir, { recursive: true })
    await page.screenshot({ path: join(screenshotDir, 'model-settings-empty.png'), fullPage: true })
    await page.getByRole('button', { name: '添加提供商', exact: true }).click()
    const form = page.getByRole('dialog', { name: '添加模型提供商' })
    const preset = form.getByLabel('提供商预设')
    await preset.selectOption('deepseek')
    assert.equal(await form.getByRole('button', { name: 'Continue with ChatGPT' }).count(), 0)
    await preset.selectOption('openai')
    assert.equal(await form.getByRole('button', { name: 'Continue with ChatGPT' }).count(), 0)
    await preset.selectOption('custom')
    await form.getByLabel('实例名称').fill('Browser gateway')
    await form.getByLabel('API 地址').fill(`${remote.url}/v1`)
    await form.getByLabel('API Key', { exact: true }).fill('browser-private-key')
    await form.getByLabel('模型 ID').fill('browser-custom-model')
    await preset.selectOption('chatgpt')
    await form.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).waitFor()
    assert.equal(await form.getByLabel('API Key', { exact: true }).count(), 0)
    assert.equal(await form.getByRole('button', { name: '保存连接', exact: true }).count(), 0)
    await page.screenshot({ path: join(screenshotDir, 'chatgpt-preset.png'), fullPage: true })
    await page.setViewportSize({ width: 320, height: 720 })
    assert.equal(await form.evaluate((dialog) => dialog.scrollWidth > dialog.clientWidth), false)
    await page.screenshot({
      path: join(screenshotDir, 'chatgpt-preset-mobile.png'),
      fullPage: true,
    })
    await page.setViewportSize({ width: 1280, height: 900 })
    await preset.selectOption('custom')
    assert.equal(
      await form.getByLabel('API Key', { exact: true }).inputValue(),
      'browser-private-key',
    )
    assert.equal(await form.getByLabel('模型 ID').inputValue(), 'browser-custom-model')
    await form.getByText('高级设置', { exact: true }).click()
    await form.getByLabel('自定义请求头').fill('{"X-Gateway-Key":"browser-private-header"}')
    await page.screenshot({
      path: join(screenshotDir, 'model-connection-form.png'),
      fullPage: true,
    })
    const saveGate = Promise.withResolvers()
    await page.route('**/api/v1/model-providers', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      await saveGate.promise
      const response = await route.fetch()
      await page.route(
        '**/api/v1/meta',
        (meta) =>
          meta.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'unavailable', message: '状态刷新失败' } }),
          }),
        { times: 1 },
      )
      await route.fulfill({ response })
    })
    try {
      await form.getByRole('button', { name: '保存连接', exact: true }).click()
      await form.getByRole('button', { name: '正在保存…', exact: true }).waitFor()
      assert.equal(await form.getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
      assert.equal(await form.getByRole('button', { name: '关闭模型设置' }).isDisabled(), true)
      await page.keyboard.press('Escape')
      assert.equal(await form.isVisible(), true)
    } finally {
      saveGate.resolve()
    }
    await form.waitFor({ state: 'hidden' })
    await page
      .getByText('连接已保存，但聊天状态刷新失败，请重新打开设置。', { exact: true })
      .waitFor()
    await page.unroute('**/api/v1/model-providers')
    assert.equal(
      (
        await page.evaluate(
          async () => (await (await fetch('/api/v1/model-providers')).json()).instances,
        )
      ).length,
      1,
    )
    await page.getByRole('button', { name: '选择 Browser gateway', exact: true }).click()
    assert.equal(await page.getByRole('region', { name: 'ChatGPT 连接' }).count(), 0)
    await page.getByRole('combobox', { name: '当前模型', exact: true }).waitFor()
    await page
      .getByText('选择后点击“设为默认模型”；已有对话保持原模型。', { exact: true })
      .waitFor()
    const testGate = Promise.withResolvers()
    await page.route(
      '**/api/v1/model-providers/*/test',
      async (route) => {
        await testGate.promise
        await route.continue()
      },
      { times: 1 },
    )
    try {
      await page.getByRole('button', { name: '测试连接', exact: true }).click()
      assert.equal(
        await page.getByRole('button', { name: '正在测试…', exact: true }).isDisabled(),
        true,
      )
    } finally {
      testGate.resolve()
    }
    await page.getByText('连接测试成功。', { exact: true }).waitFor()
    assert.equal(remote.requests[0].body.messages.at(-1).content, 'Reply with OK.')
    assert.equal(
      await page.evaluate(async () => (await (await fetch('/api/v1/meta')).json()).configured),
      false,
      'Saving and probing do not select a model',
    )
    await page.getByRole('button', { name: '设为默认模型', exact: true }).click()
    await page.getByRole('link', { name: '返回聊天', exact: true }).click()
    await composer.fill('Browser first message')
    const alternate = await page.evaluate(async (baseUrl) => {
      const state = await (
        await fetch('/api/v1/model-providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Alternate gateway',
            vendor: 'custom',
            protocol: 'openai-chat',
            baseUrl,
            authentication: 'api-key',
            apiKey: 'alternate-private-key',
            models: [{ id: 'alternate-model' }],
          }),
        })
      ).json()
      return state.instances.at(-1)
    }, `${remote.url}/v1`)
    const picker = page.getByRole('button', { name: '选择聊天模型', exact: true })
    const pickerPanel = page.getByRole('dialog', { name: '聊天模型选择', exact: true })
    await picker.click()
    await pickerPanel.getByLabel('供应商实例').selectOption(alternate.id)
    assert.equal(
      (await page.evaluate(async () => (await fetch('/api/v1/conversations')).json())).length,
      0,
      'Browsing the picker must not create a conversation',
    )
    await page.keyboard.press('Escape')
    await pickerPanel.waitFor({ state: 'hidden' })
    await picker.click()
    await pickerPanel.getByLabel('供应商实例').selectOption(alternate.id)
    await pickerPanel.getByRole('button', { name: '使用此模型', exact: true }).click()
    await pickerPanel.waitFor({ state: 'hidden' })
    await page
      .locator('.chat-header')
      .getByText('Alternate gateway / alternate-model', { exact: true })
      .waitFor()
    assert.equal(await composer.inputValue(), 'Browser first message')
    const created = await page.evaluate(async () => (await fetch('/api/v1/conversations')).json())
    assert.equal(created.length, 1)
    const originalId = created[0].id
    const beforeChoice = await page.evaluate(
      async (id) => (await fetch(`/api/v1/conversations/${id}`)).json(),
      originalId,
    )
    const primary = (
      await page.evaluate(async () => (await fetch('/api/v1/model-providers')).json())
    ).instances[0]
    await picker.click()
    await pickerPanel.getByLabel('供应商实例').selectOption(primary.id)
    await page.route(
      '**/api/v1/conversations/*/model',
      (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'unavailable', message: '切换暂不可用' } }),
        }),
      { times: 1 },
    )
    await pickerPanel.getByRole('button', { name: '使用此模型', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '切换暂不可用' }).waitFor()
    assert.equal(await composer.inputValue(), 'Browser first message')
    await pickerPanel.getByRole('button', { name: '使用此模型', exact: true }).click()
    await pickerPanel.waitFor({ state: 'hidden' })
    await page
      .locator('.chat-header')
      .getByText('Browser gateway / browser-custom-model', { exact: true })
      .waitFor()
    const chosen = await page.evaluate(async () => (await fetch('/api/v1/conversations')).json())
    assert.equal(chosen.length, 1)
    assert.equal(
      chosen[0].id,
      originalId,
      'Choosing a model in an empty conversation keeps its identity',
    )
    assert.equal(chosen[0].selection.instanceId, primary.id)
    assert.equal(
      (await page.evaluate(async () => (await fetch('/api/v1/model-providers')).json()))
        .defaultSelection.instanceId,
      primary.id,
    )
    const settingsRefresh = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/v1/conversations/${originalId}` &&
        response.request().method() === 'GET',
    )
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await settingsRefresh
    await page.route(
      `**/api/v1/conversations/${originalId}`,
      (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(beforeChoice) }),
      { times: 1 },
    )
    const staleRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/v1/conversations/${originalId}` &&
        response.request().method() === 'GET',
    )
    await page.getByRole('link', { name: '返回聊天', exact: true }).click()
    await staleRead
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
        ),
    )
    await page
      .locator('.chat-header')
      .getByText('Browser gateway / browser-custom-model', { exact: true })
      .waitFor()
    const callsBeforeStaleSend = remote.requests.length
    await page.evaluate(
      async ({ id, instanceId }) =>
        fetch(`/api/v1/conversations/${id}/model`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instanceId, modelId: 'alternate-model' }),
        }),
      { id: originalId, instanceId: alternate.id },
    )
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '会话模型已改变' }).waitFor()
    assert.equal(remote.requests.length, callsBeforeStaleSend)
    assert.equal(await composer.inputValue(), 'Browser first message')
    await page.getByRole('alert').getByRole('button', { name: '重试', exact: true }).click()
    await page
      .locator('.chat-header')
      .getByText('Alternate gateway / alternate-model', { exact: true })
      .waitFor()
    await picker.click()
    await pickerPanel.getByLabel('供应商实例').selectOption(primary.id)
    await pickerPanel.getByRole('button', { name: '使用此模型', exact: true }).click()
    await pickerPanel.waitFor({ state: 'hidden' })
    await page
      .locator('.chat-header')
      .getByText('Browser gateway / browser-custom-model', { exact: true })
      .waitFor()
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.getByText('Provider reply', { exact: true }).waitFor()
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '编辑连接', exact: true }).click()
    const edit = page.getByRole('dialog', { name: '编辑供应商实例' })
    assert.equal(await edit.getByPlaceholder('已保存，留空保持不变').inputValue(), '')
    assert.equal(await edit.getByLabel('自定义请求头').inputValue(), '')
    await edit.getByLabel('实例名称').fill('Renamed gateway')
    await edit.getByRole('button', { name: '保存连接', exact: true }).click()
    await edit.waitFor({ state: 'hidden' })
    await page.reload()
    assert.equal(new URL(page.url()).hash, '#/settings')
    await page.getByRole('heading', { name: '设置', exact: true }).waitFor()
    await page.getByRole('button', { name: '选择 Renamed gateway', exact: true }).waitFor()
    assert.equal(
      await page
        .getByRole('button', { name: '选择 Renamed gateway', exact: true })
        .getAttribute('aria-pressed'),
      'true',
    )
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await page.getByText('连接测试成功。', { exact: true }).waitFor()
    assert.equal(remote.requests.at(-1).headers.authorization, 'Bearer browser-private-key')
    assert.equal(remote.requests.at(-1).headers['x-gateway-key'], 'browser-private-header')
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(localStorage)), /browser-private/)
    await page.getByRole('button', { name: '获取模型', exact: true }).click()
    await page.getByText('模型列表已更新。', { exact: true }).waitFor()
    assert.equal(
      await page.getByRole('combobox', { name: '当前模型', exact: true }).locator('option').count(),
      2,
    )
    await page.getByRole('button', { name: '编辑连接', exact: true }).click()
    await edit.getByRole('button', { name: '保存连接', exact: true }).click()
    await edit.waitFor({ state: 'hidden' })
    const saved = await page.evaluate(async () => (await fetch('/api/v1/model-providers')).json())
    assert.equal(saved.instances[0].models[1].contextWindow, 65536)
    assert.equal(saved.instances[0].models[1].maxOutputTokens, 8192)
    await page.getByLabel('当前模型', { exact: true }).selectOption('discovered-model')
    await page.getByRole('button', { name: '设为默认模型', exact: true }).click()
    await page
      .getByText('新会话默认：Renamed gateway · discovered-model', { exact: true })
      .waitFor()
    await page.getByRole('link', { name: '返回聊天', exact: true }).click()
    await page
      .locator('.chat-header')
      .getByText('Renamed gateway / browser-custom-model', { exact: true })
      .waitFor()
    await composer.fill('Continue on the original binding')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.getByText('Provider reply', { exact: true }).nth(1).waitFor()
    await page.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' })
    assert.equal(remote.requests.at(-1).body.model, 'browser-custom-model')
    await picker.click()
    await pickerPanel.getByLabel('供应商实例').selectOption(primary.id)
    await pickerPanel.getByLabel('聊天模型', { exact: true }).selectOption('discovered-model')
    assert.equal(
      await pickerPanel.getByLabel('聊天模型', { exact: true }).inputValue(),
      'discovered-model',
    )
    await pickerPanel.getByRole('button', { name: '使用并新建对话', exact: true }).click()
    await pickerPanel.waitFor({ state: 'hidden' })
    await page
      .locator('.chat-header')
      .getByText('Renamed gateway / discovered-model', { exact: true })
      .waitFor()
    await composer.fill('New conversation uses the chosen model')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.getByText('Provider reply', { exact: true }).waitFor()
    await page.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' })
    assert.equal(remote.requests.at(-1).body.model, 'discovered-model')
    await composer.fill('Keep this draft while choosing another supplier')
    await picker.click()
    await pickerPanel.getByLabel('供应商实例').selectOption(alternate.id)
    await page.screenshot({
      path: join(screenshotDir, 'composer-model-picker.png'),
      fullPage: true,
    })
    await pickerPanel.getByRole('button', { name: '使用并新建对话', exact: true }).click()
    await pickerPanel.waitFor({ state: 'hidden' })
    await page
      .locator('.chat-header')
      .getByText('Alternate gateway / alternate-model', { exact: true })
      .waitFor()
    assert.equal(await composer.inputValue(), 'Keep this draft while choosing another supplier')
    remote.hold = true
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.getByText('Provider reply', { exact: true }).waitFor()
    assert.equal(await picker.getAttribute('aria-disabled'), 'true')
    await picker.click({ force: true })
    assert.equal(await pickerPanel.count(), 0)
    assert.ok(remote.gate)
    remote.gate.resolve()
    remote.hold = false
    await page.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' })
    assert.equal(remote.requests.at(-1).headers.authorization, 'Bearer alternate-private-key')
    assert.equal(remote.requests.at(-1).body.model, 'alternate-model')
    assert.doesNotMatch(
      JSON.stringify(remote.requests.at(-1).body.messages),
      /Browser first message|original binding/,
    )
    const preserved = await page.evaluate(
      async (id) => (await fetch(`/api/v1/conversations/${id}`)).json(),
      originalId,
    )
    assert.equal(preserved.conversation.binding.instanceId, primary.id)
    assert.equal(preserved.messages.length, 4)
    assert.deepEqual(
      (await page.evaluate(async () => (await fetch('/api/v1/model-providers')).json()))
        .defaultSelection,
      { instanceId: primary.id, modelId: 'discovered-model' },
    )
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '选择 Renamed gateway', exact: true }).click()
    await page.screenshot({ path: join(screenshotDir, 'model-connections.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: '编辑连接', exact: true }).click()
    await edit.waitFor()
    assert.equal(
      await page.evaluate(() => window.document.documentElement.scrollWidth > window.innerWidth),
      false,
    )
    await page.screenshot({
      path: join(screenshotDir, 'model-connection-mobile.png'),
      fullPage: true,
    })
    await page.keyboard.press('Escape')
    await edit.waitFor({ state: 'hidden' })
    await page.screenshot({
      path: join(screenshotDir, 'model-settings-mobile.png'),
      fullPage: true,
    })
    await page.setViewportSize({ width: 320, height: 720 })
    assert.equal(
      await page.evaluate(() => window.document.documentElement.scrollWidth > window.innerWidth),
      false,
    )
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('link', { name: '返回聊天', exact: true }).click()
    await picker.click()
    await pickerPanel.getByLabel('供应商实例').waitFor()
    const panelBounds = await pickerPanel.boundingBox()
    assert.ok(panelBounds.x >= 0 && panelBounds.x + panelBounds.width <= 390)
    assert.ok(panelBounds.y >= 0 && panelBounds.y + panelBounds.height <= 844)
    await page.screenshot({
      path: join(screenshotDir, 'composer-model-picker-mobile.png'),
      fullPage: true,
    })
    await composer.click()
    await pickerPanel.waitFor({ state: 'hidden' })
    await page.getByLabel('主题', { exact: true }).selectOption('dark')
    await page.locator('html.dark').waitFor()
    await picker.click()
    await pickerPanel.getByLabel('供应商实例').waitFor()
    await page.screenshot({
      path: join(screenshotDir, 'composer-model-picker-dark.png'),
      fullPage: true,
    })
    await page.keyboard.press('Escape')
    await pickerPanel.waitFor({ state: 'hidden' })
    assert.deepEqual(errors, [])
  },
)
