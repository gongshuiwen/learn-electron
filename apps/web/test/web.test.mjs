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

for (const operation of ['polling', 'cancelling']) {
  test(
    `Web recovers a missing ChatGPT login while ${operation}`,
    { timeout: 30_000 },
    async (t) => {
      const authorizationUrl = `https://auth.openai.com/api/accounts/authorize?${new URLSearchParams(
        {
          client_id: 'test-client',
          response_type: 'code',
          redirect_uri: 'http://127.0.0.1:12345/auth/callback',
          state: 'state',
          nonce: 'nonce',
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
        },
      )}`
      let pendingLogin = {
        id: 'old-login',
        status: 'pending',
        authorizationUrl,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      }
      let oldReads = 0
      let cancelCalls = 0
      const starts = []
      const accounts = [
        {
          id: 'old-account',
          kind: 'chatgpt',
          vendor: 'openai',
          name: 'Old',
          status: 'authorizing',
          planUsage: false,
        },
      ]
      const { page } = await fixture(t, (api) => {
        const handle = api.handle.bind(api)
        api.handle = async (route) => {
          const request = route.request()
          const path = new URL(request.url()).pathname.replace('/api/v1', '')
          const json = (body, status = 200) =>
            route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
          const missing = () => {
            pendingLogin = null
            accounts[0].status = 'signed_out'
            return json(
              { error: { code: 'login_not_found', message: '登录请求不存在，请重新登录' } },
              404,
            )
          }
          if (path === '/meta')
            return json({
              apiVersion: 1,
              engine: 'pi',
              model: { provider: 'openai', id: 'unconfigured' },
              configured: false,
              selection: null,
              target: null,
              capabilities: { tools: false },
              authMode: 'chatgpt',
            })
          if (path === '/model-providers') {
            if (request.method() === 'POST')
              accounts.push({
                id: 'new-account',
                kind: 'chatgpt',
                vendor: 'openai',
                name: 'New',
                status: 'signed_out',
                planUsage: false,
              })
            return json({
              defaultSelection: null,
              instances: accounts,
              chatgpt: { enabled: true, ...(pendingLogin ? { pendingLogin } : {}) },
            })
          }
          if (
            path === '/model-providers/new-account/auth/attempts' &&
            request.method() === 'POST'
          ) {
            assert.equal(pendingLogin, null)
            starts.push(request.method())
            accounts.at(-1).status = 'authorizing'
            pendingLogin = {
              id: 'new-login',
              status: 'pending',
              authorizationUrl,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }
            return json(pendingLogin, 201)
          }
          if (
            path === '/model-auth-attempts/old-login' ||
            path === '/model-auth-attempts/old-login/cancel'
          ) {
            if (request.method() === 'POST') {
              if (++cancelCalls === 1)
                return json({ error: { code: 'unavailable', message: '取消暂不可用' } }, 503)
              return missing()
            }
            oldReads++
            if (operation === 'polling') {
              if (oldReads === 1)
                return json({ error: { code: 'unavailable', message: '服务暂不可用' } }, 503)
              return missing()
            }
            return pendingLogin ? json(pendingLogin) : missing()
          }
          if (path === '/model-auth-attempts/new-login') return json(pendingLogin)
          return handle(route)
        }
      })
      await page
        .context()
        .route('https://auth.openai.com/api/accounts/authorize?**', (route) =>
          route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<p>新的登录请求</p>' }),
        )
      await page.getByRole('link', { name: '设置', exact: true }).click()
      const reauthorize = page.getByRole('button', { name: '重新授权 ChatGPT', exact: true })
      const cancel = page.getByRole('button', { name: '取消登录', exact: true })
      await cancel.waitFor()
      if (operation === 'polling') {
        await page.getByText('登录状态暂不可用，正在重新连接…', { exact: true }).waitFor()
        assert.equal(await reauthorize.isDisabled(), true)
        assert.equal(await cancel.isVisible(), true)
        await page.getByText('登录请求已失效，请重新登录。', { exact: true }).waitFor()
      } else {
        await cancel.click()
        await page.getByText('取消暂不可用', { exact: true }).waitFor()
        assert.equal(await reauthorize.isDisabled(), true)
        assert.equal(await cancel.isVisible(), true)
        await cancel.click()
      }
      await cancel.waitFor({ state: 'hidden' })
      const readsAfterRecovery = oldReads
      await page.getByRole('button', { name: '添加账号', exact: true }).click()
      const form = page.getByRole('dialog', { name: '添加模型提供商' })
      assert.equal(await form.getByLabel('提供商预设').inputValue(), 'chatgpt')
      const popupEvent = page.context().waitForEvent('page')
      const newPoll = page.waitForResponse((response) =>
        response.url().endsWith('/model-auth-attempts/new-login'),
      )
      await form.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click()
      await (await popupEvent).getByText('新的登录请求', { exact: true }).waitFor()
      await newPoll
      assert.deepEqual(starts, ['POST'])
      assert.equal(await cancel.isVisible(), true)
      assert.equal(oldReads, readsAfterRecovery)
    },
  )
}

test(
  'Web reuses the newly created ChatGPT account after login startup fails',
  { timeout: 20_000 },
  async (t) => {
    const accounts = []
    const attempts = []
    let createFailures = 1
    const retryStarted = Promise.withResolvers()
    const retryGate = Promise.withResolvers()
    const { page } = await fixture(t, (api) => {
      const handle = api.handle.bind(api)
      api.handle = async (route) => {
        const request = route.request()
        const path = new URL(request.url()).pathname.replace('/api/v1', '')
        const json = (body, status = 200) =>
          route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
        if (path === '/meta')
          return json({
            apiVersion: 1,
            engine: 'pi',
            model: { provider: 'unconfigured', id: 'unconfigured' },
            configured: false,
            selection: null,
            target: null,
            capabilities: { tools: false },
          })
        if (path === '/model-providers') {
          if (request.method() === 'POST') {
            if (createFailures-- > 0)
              return json({ error: { code: 'unavailable', message: '创建暂不可用' } }, 503)
            accounts.push({
              id: 'account-' + (accounts.length + 1),
              kind: 'chatgpt',
              vendor: 'openai',
              name: '未完成的连接 ' + (accounts.length + 1),
              status: 'signed_out',
              planUsage: false,
            })
          }
          return json({ defaultSelection: null, instances: accounts, chatgpt: { enabled: true } })
        }
        if (path.endsWith('/auth/attempts')) {
          attempts.push(path)
          if (attempts.length === 2) {
            retryStarted.resolve()
            await retryGate.promise
          }
          return json({ error: { code: 'unavailable', message: '授权暂不可用' } }, 503)
        }
        return handle(route)
      }
    })
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '添加提供商', exact: true }).click()
    const form = page.getByRole('dialog', { name: '添加模型提供商' })
    await form.getByLabel('提供商预设').selectOption('chatgpt')
    await form.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click()
    await form.getByRole('alert').filter({ hasText: '创建暂不可用' }).waitFor()
    assert.equal(accounts.length, 0)
    await form.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '授权暂不可用' }).waitFor()
    await page.getByRole('button', { name: '选择 ChatGPT · 未完成的连接 1', exact: true }).waitFor()
    const retry = page.waitForResponse((response) => response.url().endsWith('/auth/attempts'))
    try {
      await page.getByRole('button', { name: '重新授权 ChatGPT', exact: true }).click()
      await retryStarted.promise
      await page.getByRole('button', { name: '添加提供商', exact: true }).click()
      assert.equal(
        await form.getByRole('button', { name: '保存连接', exact: true }).isDisabled(),
        true,
      )
      await form.getByRole('button', { name: '取消', exact: true }).click()
      await form.waitFor({ state: 'hidden' })
    } finally {
      retryGate.resolve()
    }
    await retry
    await page.getByRole('alert').filter({ hasText: '授权暂不可用' }).waitFor()
    assert.deepEqual(attempts, [
      '/model-providers/account-1/auth/attempts',
      '/model-providers/account-1/auth/attempts',
    ])
    assert.equal(accounts.length, 1)
  },
)

test(
  'Web browses provider instances without selecting a default and scopes account logout',
  { timeout: 20_000 },
  async (t) => {
    let defaultSelection = { instanceId: 'account-a', modelId: 'model-account-a' }
    let connectionReads = 0
    const signedOut = new Set()
    const selections = []
    const profiles = ['account-a', 'account-b'].map((id) => ({
      id,
      kind: 'chatgpt',
      vendor: 'openai',
      name: id,
      status: 'connected',
      planUsage: true,
    }))
    const keyConnection = {
      id: 'api-connection',
      kind: 'endpoint',
      vendor: 'custom',
      revision: 1,
      name: 'API gateway',
      protocol: 'openai-chat',
      baseUrl: 'https://gateway.example/v1',
      authentication: 'api-key',
      compatibility: {},
      models: [{ id: 'api-model', name: 'API model', contextWindow: 32768, maxOutputTokens: 4096 }],
      hasCredential: true,
      hasHeaders: false,
    }
    const { page } = await fixture(t, (api) => {
      const handle = api.handle.bind(api)
      api.handle = (route) => {
        const request = route.request()
        const path = new URL(request.url()).pathname.replace('/api/v1', '')
        const json = (body) =>
          route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
        const meta = () => ({
          apiVersion: 1,
          engine: 'pi',
          model: { provider: 'test', id: defaultSelection.modelId },
          configured: !signedOut.has(defaultSelection.instanceId),
          selection: null,
          target: null,
          capabilities: { tools: false },
        })
        if (path === '/meta') return json(meta())
        api.handleModelState = () =>
          json({
            defaultSelection,
            chatgpt: { enabled: true },
            instances: [
              keyConnection,
              ...profiles.map((profile) =>
                signedOut.has(profile.id)
                  ? { ...profile, status: 'signed_out', planUsage: false }
                  : profile,
              ),
            ],
          })
        if (path === '/model-providers') {
          connectionReads++
          return api.handleModelState()
        }
        const models = /^\/model-providers\/(account-[ab])\/models$/.exec(path)
        if (models)
          return json([
            {
              id: 'model-' + models[1],
              name: 'Model ' + models[1],
              contextWindow: 32768,
              maxOutputTokens: 4096,
            },
          ])
        if (path === '/model' && request.method() === 'PUT') {
          defaultSelection = request.postDataJSON()
          assert.equal(
            defaultSelection.modelId,
            defaultSelection.instanceId === 'api-connection'
              ? 'api-model'
              : 'model-' + defaultSelection.instanceId,
          )
          selections.push(defaultSelection)
          return api.handleModelState()
        }
        if (path === '/model-providers/account-b/auth/logout') {
          assert.equal(request.method(), 'POST')
          signedOut.add('account-b')
          return json({ revoked: true })
        }
        return handle(route)
      }
    })
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await page
      .getByRole('combobox', { name: '当前模型', exact: true })
      .locator('option')
      .filter({ hasText: 'Model account-a' })
      .waitFor({ state: 'attached' })
    assert.equal(connectionReads, 1, 'One authoritative initial connection read')
    await page.getByRole('button', { name: '选择 ChatGPT · account-b', exact: true }).click()
    await page
      .getByRole('combobox', { name: '当前模型', exact: true })
      .locator('option')
      .filter({ hasText: 'Model account-b' })
      .waitFor({ state: 'attached' })
    assert.equal(
      defaultSelection.instanceId,
      'account-a',
      'Browsing an account does not activate it',
    )
    assert.deepEqual(selections, [])
    await page.getByRole('button', { name: '设为默认模型', exact: true }).click()
    await page.getByText('新会话默认：account-b · model-account-b', { exact: true }).waitFor()
    assert.equal(connectionReads, 2)
    await page.getByRole('button', { name: '选择 API gateway', exact: true }).click()
    await page.getByRole('button', { name: '设为默认模型', exact: true }).click()
    await page.getByText('新会话默认：API gateway · api-model', { exact: true }).waitFor()
    await page.getByRole('button', { name: '选择 ChatGPT · account-b', exact: true }).click()
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('button', { name: '退出登录', exact: true }).waitFor({ state: 'hidden' })
    assert.equal(defaultSelection.instanceId, 'api-connection')
    assert.equal(connectionReads, 4)
    assert.deepEqual(selections, [
      { instanceId: 'account-b', modelId: 'model-account-b' },
      { instanceId: 'api-connection', modelId: 'api-model' },
    ])
    await page.getByRole('link', { name: '返回聊天', exact: true }).click()
    assert.equal(
      await page.getByRole('textbox', { name: '发送消息', exact: true }).isDisabled(),
      false,
    )
  },
)

test(
  'Web shows availability for each ChatGPT account without disabling other models',
  { timeout: 20_000 },
  async (t) => {
    const endpoint = {
      id: 'gateway',
      kind: 'endpoint',
      revision: 1,
      vendor: 'custom',
      name: 'Gateway',
      protocol: 'openai-chat',
      baseUrl: 'https://gateway.example/v1',
      authentication: 'none',
      compatibility: {},
      models: [
        { id: 'gateway-model', name: 'Gateway model', contextWindow: 32768, maxOutputTokens: 4096 },
      ],
      hasCredential: false,
      hasHeaders: false,
    }
    const needsKey = { ...endpoint, id: 'needs-key', name: 'Needs key', authentication: 'api-key' }
    const noModels = { ...endpoint, id: 'no-models', name: 'Empty catalog', models: [] }
    const profiles = [
      { id: 'account-a', status: 'authorizing' },
      { id: 'account-b', status: 'busy' },
      { id: 'account-c', status: 'connected' },
    ].map((profile) => ({
      ...profile,
      kind: 'chatgpt',
      vendor: 'openai',
      name: profile.id,
      planUsage: true,
    }))
    const selection = { instanceId: endpoint.id, modelId: endpoint.models[0].id }
    const pendingLogin = {
      id: 'pending-login',
      status: 'pending',
      authorizationUrl: 'https://auth.openai.com/api/accounts/authorize',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    }
    let completed = false
    let polls = 0
    const { page } = await fixture(t, (api) => {
      const handle = api.handle.bind(api)
      api.handle = (route) => {
        const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
        const json = (body) =>
          route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
        if (path === '/meta')
          return json({
            apiVersion: 1,
            engine: 'pi',
            model: { provider: endpoint.name, id: selection.modelId },
            configured: true,
            selection,
            target: selection,
            capabilities: { tools: false },
          })
        if (path === '/model-providers')
          return json({
            defaultSelection: selection,
            instances: [endpoint, needsKey, noModels, ...profiles],
            chatgpt: { enabled: true, ...(!completed ? { pendingLogin } : {}) },
          })
        if (
          ['/model-providers/account-a/models', '/model-providers/account-c/models'].includes(path)
        )
          return json([
            { id: 'chat-model', name: 'Chat model', contextWindow: 32768, maxOutputTokens: 4096 },
          ])
        if (path === '/model-auth-attempts/pending-login') {
          polls++
          if (!completed) return json(pendingLogin)
          profiles[0].status = 'connected'
          return json({ ...pendingLogin, status: 'completed', instanceId: 'account-a' })
        }
        return handle(route)
      }
    })
    await page.getByRole('button', { name: '选择聊天模型', exact: true }).click()
    const picker = page.getByRole('dialog', { name: '聊天模型选择', exact: true })
    const select = picker.getByLabel('供应商实例')
    const use = picker.getByRole('button', { name: '使用此模型', exact: true })
    await select.selectOption('account-a')
    await picker.getByText('该账号正在授权，请完成或取消登录。', { exact: true }).waitFor()
    assert.equal(await use.isDisabled(), true)
    await select.selectOption('account-b')
    await picker.getByText('该账号正在更新，请稍后再试。', { exact: true }).waitFor()
    assert.equal(await use.isDisabled(), true)
    await select.selectOption('account-c')
    await picker
      .getByLabel('聊天模型')
      .locator('option')
      .filter({ hasText: 'Chat model' })
      .waitFor({ state: 'attached' })
    assert.equal(await use.isEnabled(), true)
    await page.keyboard.press('Escape')
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '选择 Needs key', exact: true }).click()
    await page.getByText('请先编辑连接并补充 API Key，才能使用此连接。', { exact: true }).waitFor()
    assert.equal(
      await page.getByRole('button', { name: '获取模型', exact: true }).isDisabled(),
      true,
    )
    await page.getByRole('button', { name: '选择 Empty catalog', exact: true }).click()
    await page.getByText('暂无模型，请获取模型或编辑连接手动添加。', { exact: true }).waitFor()
    assert.equal(
      await page.getByRole('button', { name: '获取模型', exact: true }).isEnabled(),
      true,
    )
    assert.equal(
      await page.getByRole('button', { name: '测试连接', exact: true }).isDisabled(),
      true,
    )
    await page.getByRole('button', { name: '选择 ChatGPT · account-a', exact: true }).click()
    await page.getByText('请在系统浏览器中完成此账号的授权…', { exact: true }).waitFor()
    await page.getByText('请先完成 ChatGPT 授权，再选择模型。', { exact: true }).waitFor()
    const accountBox = await page.getByRole('region', { name: 'ChatGPT 连接' }).boundingBox()
    const modelBox = await page.getByRole('combobox', { name: '当前模型' }).boundingBox()
    assert.ok(accountBox.y + accountBox.height <= modelBox.y)
    await page.getByRole('button', { name: '选择 ChatGPT · account-b', exact: true }).click()
    await page.getByText('此账号正在更新，请稍后再试。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '选择 ChatGPT · account-c', exact: true }).click()
    await page.getByText('已授权 · 可使用 ChatGPT 计划', { exact: true }).waitFor()
    const gateway = page.getByRole('button', { name: '选择 Gateway', exact: true })
    await gateway.click()
    assert.equal(await page.getByRole('region', { name: 'ChatGPT 连接' }).count(), 0)
    completed = true
    await page
      .getByRole('button', { name: '选择 ChatGPT · account-a', exact: true })
      .getByText('ChatGPT · 已授权', { exact: true })
      .waitFor()
    assert.ok(polls > 0, 'Login continues while another provider is selected')
    assert.equal(await gateway.getAttribute('aria-pressed'), 'true')
    assert.equal(await page.getByRole('region', { name: 'ChatGPT 连接' }).count(), 0)
    await page.getByText('ChatGPT 登录成功，可在供应商列表中查看账号。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '选择 ChatGPT · account-c', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '知道了', exact: true }).count(), 0)
    await page.getByRole('button', { name: '选择 ChatGPT · account-a', exact: true }).click()
    await page.getByRole('button', { name: '知道了', exact: true }).waitFor()
  },
)

test(
  'Web ignores stale model status and sends the visible selection when the default changes',
  { timeout: 30_000 },
  async (t) => {
    const a = { instanceId: 'provider-a', modelId: 'model-a' }
    const b = { instanceId: 'provider-b', modelId: 'model-b' }
    let selected = a
    let phase = 'initial'
    let oldHeld = false
    let returnHeld = false
    const oldStarted = Promise.withResolvers()
    const oldGate = Promise.withResolvers()
    const oldDone = Promise.withResolvers()
    const newDone = Promise.withResolvers()
    const returnStarted = Promise.withResolvers()
    const returnGate = Promise.withResolvers()
    const created = Promise.withResolvers()
    const submitted = Promise.withResolvers()
    t.after(() => {
      oldGate.resolve()
      returnGate.resolve()
    })
    const instances = [a, b].map((ref) => ({
      id: ref.instanceId,
      kind: 'endpoint',
      revision: 1,
      vendor: 'custom',
      name: ref === a ? 'Gateway A' : 'Gateway B',
      protocol: 'openai-chat',
      baseUrl: 'https://gateway.example/v1',
      authentication: 'none',
      compatibility: {},
      models: [{ id: ref.modelId, name: ref.modelId, contextWindow: 32768, maxOutputTokens: 4096 }],
      hasCredential: false,
      hasHeaders: false,
    }))
    const { page, input } = await fixture(t, (api) => {
      const handle = api.handle.bind(api)
      api.handle = async (route) => {
        const request = route.request()
        const path = new URL(request.url()).pathname.replace('/api/v1', '')
        const json = (body) =>
          route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
        const state = () => ({ defaultSelection: selected, instances, chatgpt: { enabled: true } })
        if (path === '/meta') {
          const snapshot = {
            apiVersion: 1,
            engine: 'pi',
            model: {
              provider: selected.instanceId === a.instanceId ? 'Gateway A' : 'Gateway B',
              id: selected.modelId,
            },
            configured: true,
            selection: selected,
            target: selected,
            capabilities: { tools: false },
          }
          if (phase === 'old' && !oldHeld) {
            oldHeld = true
            oldStarted.resolve()
            await oldGate.promise
            await json(snapshot)
            oldDone.resolve()
            return
          }
          if (phase === 'return' && !returnHeld) {
            returnHeld = true
            returnStarted.resolve()
            await returnGate.promise
            return json(snapshot)
          }
          await json(snapshot)
          if (phase === 'old' && snapshot.target.instanceId === b.instanceId) newDone.resolve()
          return
        }
        if (path === '/model-providers') return json(state())
        if (path === '/model' && request.method() === 'PUT') {
          selected = request.postDataJSON()
          return json(state())
        }
        if (path === '/conversations' && request.method() === 'POST')
          created.resolve(request.postDataJSON())
        if (path.endsWith('/runs') && request.method() === 'POST')
          submitted.resolve(request.postDataJSON())
        return handle(route)
      }
    })
    await page.locator('.chat-header').getByText('Gateway A / model-a', { exact: true }).waitFor()
    phase = 'old'
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await oldStarted.promise
    await page.getByRole('button', { name: '选择 Gateway B', exact: true }).click()
    await page.getByRole('button', { name: '设为默认模型', exact: true }).click()
    await page.getByText('新会话默认：Gateway B · model-b', { exact: true }).waitFor()
    await newDone.promise
    oldGate.resolve()
    await oldDone.promise
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
        ),
    )
    phase = 'return'
    await page.getByRole('link', { name: '返回聊天', exact: true }).click()
    await returnStarted.promise
    await page.locator('.chat-header').getByText('Gateway B / model-b', { exact: true }).waitFor()
    selected = a
    await input.fill('发送给当前显示的模型')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    assert.deepEqual((await created.promise).selection, b)
    assert.deepEqual((await submitted.promise).expectedTarget, b)
    returnGate.resolve()
  },
)

test(
  'Web settings has its own route, preserves drafts across history navigation and restores after reload',
  { timeout: 20_000 },
  async (t) => {
    const { page, input } = await fixture(t)
    await input.fill('保留在聊天中的草稿')
    const timeOrigin = await page.evaluate(() => performance.timeOrigin)
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await page.getByRole('heading', { name: '设置', exact: true }).waitFor()
    assert.equal(new URL(page.url()).hash, '#/settings')
    assert.equal(await input.count(), 0)
    await page.goBack()
    assert.equal(await input.inputValue(), '保留在聊天中的草稿')
    assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin)
    await page.goForward()
    await page.getByRole('heading', { name: '设置', exact: true }).waitFor()
    await page.reload()
    await page.getByRole('heading', { name: '设置', exact: true }).waitFor()
    await page.getByRole('button', { name: '新建对话', exact: true }).click()
    await page.getByRole('heading', { name: '新对话', exact: true }).waitFor()
    assert.equal(new URL(page.url()).hash, '#/')
  },
)

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
    await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('生成时保留的草稿')
    await page.getByRole('link', { name: '设置', exact: true }).click()
    await page.getByRole('heading', { name: '设置', exact: true }).waitFor()
    await page.getByRole('link', { name: '返回聊天', exact: true }).click()
    await page.getByRole('button', { name: '停止生成', exact: true }).waitFor()
    assert.equal(
      await page.getByRole('textbox', { name: '发送消息', exact: true }).inputValue(),
      '生成时保留的草稿',
    )
    assert.equal(api.runCount, 1)
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
  await page.getByRole('status').filter({ hasText: '会话模型不可用' }).waitFor()
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
