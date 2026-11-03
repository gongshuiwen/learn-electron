import assert from 'node:assert/strict'
import { test } from 'node:test'
import { desktopFixture } from './helpers/electron.mjs'

test(
  'Electron starts an isolated renderer and chats through its backend',
  { timeout: 30000 },
  async (t) => {
    const { launch: launchDesktop } = await desktopFixture(t, 'smoke')
    let desktop

    desktop = await launchDesktop()
    const page = await desktop.firstWindow()
    page.setDefaultTimeout(5000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.waitForLoadState('load')
    await page.locator('#root > *').first().waitFor()

    assert.equal(await page.evaluate(() => window.electronAPI.getTheme()), 'system')
    assert.deepEqual(
      await page.evaluate(() => ({
        require: typeof window.require,
        process: typeof window.process,
        getTheme: typeof window.electronAPI.getTheme,
      })),
      { require: 'undefined', process: 'undefined', getTheme: 'function' },
    )
    const preferences = await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    )
    assert.equal(preferences.contextIsolation, true)
    assert.equal(preferences.sandbox, true)
    assert.equal(preferences.nodeIntegration, false)
    assert.equal(await page.evaluate(() => window.Notification.permission), 'denied')
    assert.equal(await page.evaluate(() => window.Notification.requestPermission()), 'denied')
    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content')
    assert.ok(!csp.includes('unsafe-inline'))

    // The real renderer uses the same HTTP API as Web; main injects credentials.
    const meta = await page.evaluate(async () => {
      const response = await fetch(`${window.electronAPI.apiBaseUrl}/api/v1/meta`)
      return response.json()
    })
    assert.equal(meta.apiVersion, 1)
    assert.equal(meta.engine, 'mock')
    await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('桌面链路验证')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.getByText('演示回复：桌面链路验证', { exact: true }).waitFor()
    await page.getByRole('button', { name: '发送消息', exact: true }).waitFor()

    await page.reload()
    await page.locator('#root > *').first().waitFor()
    await page.getByText('演示回复：桌面链路验证', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  },
)
