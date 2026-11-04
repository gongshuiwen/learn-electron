import assert from 'node:assert/strict'
import { fileURLToPath, URL } from 'node:url'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'
import { fakeApi } from './fake-api.mjs'

let server
let browser

before(async () => {
  server = await preview({
    configFile: false,
    root: fileURLToPath(new URL('../', import.meta.url)),
    build: { outDir: fileURLToPath(new URL('../../../out/web/', import.meta.url)) },
    preview: { port: 0, host: '127.0.0.1' },
  })
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' })
})

after(async () => {
  await browser?.close()
  if (server) {
    await new Promise((resolve, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

async function fixture(t, configure = () => {}) {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  t.after(async () => {
    await context.close()
    assert.deepEqual(errors, [])
  })
  const api = fakeApi()
  configure(api)
  await page.route('**/api/v1/**', (route) => api.handle(route))
  await page.goto(server.resolvedUrls.local[0])
  await page.getByRole('heading', { name: '今天，想聊些什么？' }).waitFor()
  return {
    page,
    api,
    input: page.getByRole('textbox', { name: '发送消息', exact: true }),
    sidebar: page.getByRole('navigation', { name: '对话列表' }),
  }
}

async function send(page, message) {
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill(message)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
}

async function rename(page, title) {
  await page.getByRole('button', { name: '重命名对话' }).click()
  await page.getByRole('textbox', { name: '对话标题' }).fill(title)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('textbox', { name: '对话标题' }).waitFor({ state: 'hidden' })
}

test(
  'Web theme persists and follows the system without an Electron bridge',
  { timeout: 30_000 },
  async (t) => {
    const { page } = await fixture(t)
    assert.equal(await page.evaluate(() => typeof window.electronAPI), 'undefined')
    const theme = page.getByLabel('主题', { exact: true })
    await theme.selectOption('dark')
    await page.locator('html.dark').waitFor()
    await page.reload()
    await page.locator('html.dark').waitFor()
    assert.equal(await theme.inputValue(), 'dark')
    await theme.selectOption('system')
    await page.emulateMedia({ colorScheme: 'light' })
    await page.locator('html:not(.dark)').waitFor()
  },
)

test(
  'Web manages conversations and restores safely rendered HTTP chat history',
  { timeout: 30_000 },
  async (t) => {
    const { page, api, sidebar } = await fixture(t)
    await send(page, '第一条消息')
    const reply = page.getByRole('article', { name: '助手回复' })
    await reply.getByText('你好', { exact: true }).waitFor()
    await page.getByRole('button', { name: '发送消息', exact: true }).waitFor()
    assert.equal(api.lastRequest.message, '第一条消息')
    assert.match(api.lastRequest.requestId, /^[\w-]{8,128}$/)
    assert.deepEqual(Object.keys(api.lastRequest).sort(), ['message', 'requestId'])
    // Sending messages preserves the server-owned title until an explicit rename.
    assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), '新对话')
    await page.reload()
    await page
      .getByRole('article', { name: '你的消息' })
      .getByText('第一条消息', { exact: true })
      .waitFor()
    assert.equal(await reply.count(), 1)
    assert.equal(await reply.locator('img').count(), 0)
    await sidebar.getByRole('button', { name: '新对话', exact: true }).click()
    await rename(page, '保存的想法')
    await page.getByRole('button', { name: '新建对话' }).click()
    await page.getByRole('heading', { name: '今天，想聊些什么？' }).waitFor()
    await sidebar.getByRole('button', { name: '保存的想法', exact: true }).click()
    await page
      .getByRole('article', { name: '你的消息' })
      .getByText('第一条消息', { exact: true })
      .waitFor()
    await page.getByRole('button', { name: '删除对话', exact: true }).click()
    await page.getByRole('button', { name: '确认删除', exact: true }).click()
    await page.getByRole('heading', { name: '新对话', exact: true }).waitFor()
    assert.equal(await sidebar.getByRole('button').count(), 1)
  },
)

test(
  'Web reconnects and reloads an active stream without duplicating replies, then cancels',
  { timeout: 30_000 },
  async (t) => {
    const { page, api } = await fixture(t, (api) => api.setBehavior('hold'))
    await send(page, '请生成一段较长回复')
    await page.getByRole('button', { name: '停止生成' }).waitFor()
    await page
      .getByRole('article', { name: '助手回复' })
      .getByText('你好', { exact: true })
      .waitFor()
    await page.waitForResponse((response) => response.url().endsWith('/events'))
    assert.equal(await page.getByRole('article', { name: '助手回复' }).count(), 1)
    const before = api.eventReads
    const resumed = page.waitForResponse((response) => response.url().endsWith('/events'))
    await page.reload()
    await resumed
    await page
      .getByRole('article', { name: '助手回复' })
      .getByText('你好', { exact: true })
      .waitFor()
    assert.ok(api.eventReads > before, 'refresh must subscribe to the active run')
    assert.equal(await page.getByRole('article', { name: '助手回复' }).count(), 1)
    await page.getByRole('button', { name: '停止生成' }).click()
    await page.getByText('回复已停止', { exact: true }).waitFor()
    await page.getByRole('button', { name: '发送消息', exact: true }).waitFor()
  },
)

test(
  'Web preserves a rejected draft and displays a subsequent generation failure',
  { timeout: 30_000 },
  async (t) => {
    const { page, api, input } = await fixture(t, (api) => api.setBehavior('request-error'))
    await send(page, '请求失败后保留草稿')
    await page.getByRole('alert').filter({ hasText: '模型服务暂时不可用' }).waitFor()
    assert.equal(await input.inputValue(), '请求失败后保留草稿')
    api.setBehavior('run-error')
    await send(page, '生成中出错')
    await page.getByRole('alert').filter({ hasText: '生成过程中发生错误' }).waitFor()
    await page
      .getByRole('article', { name: '助手回复' })
      .getByText('你好', { exact: true })
      .waitFor()
  },
)

test(
  'Web reuses an uncertain submission key and releases it after confirmation',
  { timeout: 30_000 },
  async (t) => {
    const { page, api, input } = await fixture(t)
    await page.getByRole('button', { name: '新建对话' }).click()
    await page.getByRole('heading', { name: '新对话', exact: true }).waitFor()
    api.setBehavior('snapshot-error-once')
    await send(page, '网络中断后重试同一次提交')
    await page.getByRole('alert').filter({ hasText: 'Failed to fetch' }).waitFor()
    assert.equal(await input.inputValue(), '网络中断后重试同一次提交')
    const firstAttemptId = api.lastRequest.requestId
    api.setBehavior('complete')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page
      .getByRole('article', { name: '你的消息' })
      .getByText('网络中断后重试同一次提交', { exact: true })
      .waitFor()
    await page.getByRole('button', { name: '发送消息', exact: true }).waitFor()
    assert.equal(api.lastRequest.requestId, firstAttemptId)
    assert.equal(api.runCount, 1, 'the UI must retry the same submission')
    assert.equal(await page.getByRole('article', { name: '你的消息' }).count(), 1)
    const submitted = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/runs'),
    )
    await send(page, '网络中断后重试同一次提交')
    await submitted
    await page.getByRole('button', { name: '发送消息', exact: true }).waitFor()
    assert.notEqual(api.lastRequest.requestId, firstAttemptId)
    assert.equal(api.runCount, 2)
  },
)

test('Web updates conversation order after a rename', { timeout: 30_000 }, async (t) => {
  const { page, sidebar } = await fixture(t)
  await page.getByRole('button', { name: '新建对话' }).click()
  await rename(page, '保存的想法')
  await page.getByRole('button', { name: '新建对话' }).click()
  await page.getByRole('heading', { name: '新对话', exact: true }).waitFor()
  await sidebar.getByRole('button', { name: '保存的想法', exact: true }).click()
  await page.getByRole('heading', { name: '保存的想法', exact: true }).waitFor()
  await rename(page, '保存的想法')
  assert.equal(await sidebar.getByRole('button').first().textContent(), '保存的想法')
})

test(
  'Web isolates a delayed submission and unlocks navigation once it settles',
  { timeout: 30_000 },
  async (t) => {
    const { page, api, sidebar } = await fixture(t)
    await page.getByRole('button', { name: '新建对话' }).click()
    await rename(page, '保存的想法')
    await page.getByRole('button', { name: '新建对话' }).click()
    await page.getByRole('heading', { name: '新对话', exact: true }).waitFor()
    api.setBehavior('hold')
    const delayed = api.deferNextRun()
    await send(page, '延迟请求隔离')
    await delayed.started
    await sidebar.getByRole('button', { name: '保存的想法', exact: true }).click({ force: true })
    assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), '新对话')
    await sidebar.getByRole('button', { name: '新对话', exact: true }).click({ force: true })
    delayed.resume()
    await page
      .getByRole('article', { name: '你的消息' })
      .getByText('延迟请求隔离', { exact: true })
      .waitFor()
    await page.getByRole('button', { name: '停止生成' }).waitFor()
    assert.equal(await sidebar.getByRole('button').first().textContent(), '新对话')
    await sidebar.getByRole('button', { name: '保存的想法', exact: true }).click()
    await page.getByRole('heading', { name: '保存的想法', exact: true }).waitFor()
    assert.equal(await page.getByRole('article', { name: '你的消息' }).count(), 0)
    await sidebar.getByRole('button', { name: '新对话', exact: true }).click()
    await page
      .getByRole('article', { name: '你的消息' })
      .getByText('延迟请求隔离', { exact: true })
      .waitFor()
    await page.getByRole('button', { name: '停止生成' }).click()
    await page.getByText('回复已停止', { exact: true }).waitFor()
  },
)

for (const behavior of ['incompatible-events', 'invalid-payload', 'event-errors']) {
  test(
    `Web reports ${behavior} and resumes the same run only after retry`,
    { timeout: 30_000 },
    async (t) => {
      const { page, api } = await fixture(t, (api) => api.setBehavior(behavior))
      const streamUrls = []
      page.on('response', (response) => {
        if (response.url().endsWith('/events')) streamUrls.push(response.url())
      })
      await send(page, `校验回复流 ${behavior}`)
      await page
        .getByRole('alert')
        .filter({ hasText: /服务端事件.*不兼容|任务不存在/ })
        .waitFor()
      // Exceed the initial reconnect delay to catch an unintended retry loop.
      await page.waitForTimeout(1100)
      const attempts = behavior === 'event-errors' ? 2 : 1
      assert.equal(api.eventReads, attempts)
      const streamUrl = streamUrls[0]

      api.setBehavior('complete')
      await page.getByRole('button', { name: '重试', exact: true }).click()
      await page
        .getByRole('article', { name: '助手回复' })
        .getByText('你好', { exact: true })
        .waitFor()
      await page.getByRole('button', { name: '发送消息', exact: true }).waitFor()
      assert.deepEqual(streamUrls, Array(attempts + 1).fill(streamUrl))
      assert.equal(api.runCount, 1)
    },
  )
}

test('Web disables sending when no model is configured', { timeout: 30_000 }, async (t) => {
  const { page, input } = await fixture(t, (api) => api.setConfigured(false))
  await page.getByRole('status').filter({ hasText: '尚未配置模型' }).waitFor()
  assert.equal(await input.isDisabled(), true)
})

test(
  'Web disables sending when the HTTP API version is incompatible',
  { timeout: 30_000 },
  async (t) => {
    const { page, input } = await fixture(t, (api) => api.setApiVersion(2))
    await page.getByRole('alert').filter({ hasText: '服务端 API 版本不兼容，需要 v1' }).waitFor()
    assert.equal(await input.isDisabled(), true)
  },
)
