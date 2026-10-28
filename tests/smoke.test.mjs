import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import { promisify } from 'node:util'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
delete environment.ELECTRON_RENDERER_URL

test('Electron renders, handles IPC and isolates the renderer', { timeout: 30000 }, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'learn-electron-smoke-'))
  let desktop
  t.after(async () => {
    try {
      await desktop?.close()
    } finally {
      await rm(profile, { recursive: true, force: true })
    }
  })

  desktop = await electron.launch({
    args: [root, `--user-data-dir=${profile}`],
    cwd: root,
    chromiumSandbox: true,
    env: environment,
    timeout: 15000,
  })
  const page = await desktop.firstWindow()
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.getByRole('heading', { name: '从这里开始，构建桌面应用。' }).waitFor()
  await page.getByRole('button', { name: '点击次数：0' }).click()
  await page.getByRole('button', { name: '点击次数：1' }).waitFor()
  await page.getByRole('button', { name: '读取应用信息' }).click()
  await page.getByText(`${manifest.name} ${manifest.version}`, { exact: true }).waitFor()

  const info = await page.evaluate(() => window.electronAPI.getAppInfo())
  assert.equal(info.name, manifest.name)
  assert.equal(info.version, manifest.version)
  for (const key of ['electron', 'chrome', 'node']) assert.match(info[key], /^\d+\.\d+\.\d+/)
  assert.deepEqual(
    await page.evaluate(() => ({
      require: typeof window.require,
      process: typeof window.process,
      api: Object.keys(window.electronAPI),
    })),
    { require: 'undefined', process: 'undefined', api: ['getAppInfo'] },
  )
  const preferences = await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  )
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.nodeIntegration, false)
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content')
  assert.ok(!csp.includes('unsafe-inline'))

  // The recovery button uses location.reload(), not a debugger-initiated reload.
  const reloaded = page.waitForEvent('load')
  await page.evaluate(() => window.location.reload())
  await reloaded
  await page.getByRole('button', { name: '点击次数：0' }).waitFor()
  assert.equal((await page.evaluate(() => window.electronAPI.getAppInfo())).name, manifest.name)
  assert.deepEqual(errors, [])
})

test('A renderer load failure exits with a nonzero status', { timeout: 15000 }, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'learn-electron-failure-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  await assert.rejects(
    promisify(execFile)(electronPath, [root, `--user-data-dir=${profile}`], {
      env: {
        ...environment,
        ELECTRON_RENDERER_URL: pathToFileURL(join(profile, 'missing.html')).href,
      },
      timeout: 10000,
    }),
    (error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /Failed to start Electron/)
      return true
    },
  )
})
