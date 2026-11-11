import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { desktopFixture } from '../helpers/electron.mjs'

test(
  'Theme selection follows native colors, persists and rejects invalid values',
  { timeout: 90000 },
  async (t) => {
    const { profile, launch: launchDesktop } = await desktopFixture(t, 'theme')
    const settingsFile = join(profile, 'settings.json')
    let desktop
    async function launch() {
      desktop = await launchDesktop()
      const page = await desktop.firstWindow()
      await page.emulateMedia({ colorScheme: null })
      page.setDefaultTimeout(5000)
      await page.waitForLoadState('load')
      return page
    }
    let page = await launch()
    assert.equal(await page.evaluate(() => window.electronAPI.getTheme()), 'system')
    for (const source of ['dark', 'light', 'system']) {
      assert.equal(
        await page.evaluate((value) => window.electronAPI.setTheme(value), source),
        source,
      )
      const native = await desktop.evaluate(({ nativeTheme }) => ({
        source: nativeTheme.themeSource,
        dark: nativeTheme.shouldUseDarkColors,
      }))
      assert.equal(native.source, source)
      if (source !== 'system') assert.equal(native.dark, source === 'dark')
      await page.waitForFunction(
        (dark) => window.matchMedia('(prefers-color-scheme: dark)').matches === dark,
        native.dark,
      )
      const background = await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getBackgroundColor(),
      )
      assert.ok(background.toLowerCase().endsWith(native.dark ? '0c0a09' : 'f5f5f4'))
      assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), { theme: source })
    }
    await assert.rejects(
      page.evaluate(() => window.electronAPI.setTheme('invalid')),
      /Invalid theme/,
    )
    assert.equal(await page.evaluate(() => window.electronAPI.getTheme()), 'system')
    await page.evaluate(() => window.electronAPI.setTheme('dark'))
    await desktop.close()
    page = await launch()
    assert.equal(await page.evaluate(() => window.electronAPI.getTheme()), 'dark')
    assert.equal(
      await page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches),
      true,
    )
    await page.reload()
    assert.equal(await page.evaluate(() => window.electronAPI.getTheme()), 'dark')
    await desktop.close()
    for (const contents of ['{broken', '{"theme":"invalid"}', '{}', 'null']) {
      await writeFile(settingsFile, contents)
      page = await launch()
      assert.equal(await page.evaluate(() => window.electronAPI.getTheme()), 'system')
      await desktop.close()
    }
  },
)

test(
  'Theme IPC trusts hash routes through reloads and rejects changed queries',
  { timeout: 30000 },
  async (t) => {
    const { launch } = await desktopFixture(t, 'ipc')
    const desktop = await launch()
    const page = await desktop.firstWindow()
    page.setDefaultTimeout(5000)
    await page.locator('#root > *').first().waitFor()
    await page.evaluate(() => {
      window.location.hash = '/settings'
    })
    await page.getByRole('heading', { name: '设置', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.electronAPI.getTheme()), 'system')

    // Only the fragment may vary; a changed query must still fail the sender check.
    const routeURL = page.url()
    await page.evaluate(() => window.history.replaceState(null, '', '?untrusted=1#/settings'))
    await assert.rejects(
      page.evaluate(() => window.electronAPI.getTheme()),
      /Unexpected IPC sender/,
    )
    await assert.rejects(
      page.evaluate(() => window.electronAPI.setTheme('dark')),
      /Unexpected IPC sender/,
    )
    await page.evaluate((url) => window.history.replaceState(null, '', url), routeURL)

    // Exercise the same reload used by the error boundary, with a hash route present.
    const reloaded = page.waitForEvent('load')
    await page.evaluate(() => window.location.reload())
    await reloaded
    assert.equal(page.url(), routeURL)
    await page.locator('#root > *').first().waitFor()
    assert.equal(await page.evaluate(() => window.electronAPI.getTheme()), 'system')
    await page.getByRole('heading', { name: '设置', exact: true }).waitFor()
    await page.getByRole('link', { name: '返回聊天', exact: true }).click()
    await page.getByRole('textbox', { name: '发送消息', exact: true }).waitFor()
  },
)
