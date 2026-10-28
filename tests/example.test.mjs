import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, URL } from 'node:url'
import { _electron as electron } from 'playwright-core'

// These checks belong to the starter page and can be removed along with it.
test('Starter page counter and app information', { timeout: 30000 }, async (t) => {
  const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const profile = await mkdtemp(join(tmpdir(), 'learn-electron-example-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
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
    env,
    timeout: 15000,
  })
  const page = await desktop.firstWindow()
  // Let Electron's native theme drive media queries instead of Playwright's default.
  await page.emulateMedia({ colorScheme: null })
  page.setDefaultTimeout(5000)
  await page.getByRole('heading', { name: '从这里开始，构建桌面应用。' }).waitFor()
  await page.getByRole('button', { name: '点击次数：0' }).click()
  await page.getByRole('button', { name: '点击次数：1' }).waitFor()
  await page.getByRole('button', { name: '读取应用信息' }).click()
  await page.getByText(`${manifest.name} ${manifest.version}`, { exact: true }).waitFor()
  const theme = page.getByLabel('主题', { exact: true })
  await theme.selectOption('dark')
  await page.waitForFunction(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const darkBackground = await page
    .locator('body')
    .evaluate((element) => window.getComputedStyle(element).backgroundColor)
  await theme.selectOption('light')
  await page.waitForFunction(() => !window.matchMedia('(prefers-color-scheme: dark)').matches)
  const lightBackground = await page
    .locator('body')
    .evaluate((element) => window.getComputedStyle(element).backgroundColor)
  assert.notEqual(darkBackground, lightBackground)

  // An unwritable preference must leave the current theme intact and show an error.
  const settingsFile = join(profile, 'settings.json')
  await rm(settingsFile)
  await mkdir(settingsFile)
  await theme.selectOption('dark')
  await page.getByRole('alert').filter({ hasText: '主题设置未能保存，请重试。' }).waitFor()
  assert.equal(await theme.inputValue(), 'light')
  assert.equal(await page.evaluate(() => window.electronAPI.getTheme()), 'light')
  assert.equal(
    (await readdir(profile)).some((name) => name.startsWith('settings.') && name.endsWith('.tmp')),
    false,
  )
})
