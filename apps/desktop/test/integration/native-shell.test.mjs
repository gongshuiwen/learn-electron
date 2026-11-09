import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { desktopFixture, root } from '../helpers/electron.mjs'

test(
  'ChatGPT browser bridge opens only allowed destinations and preserves the restricted renderer',
  { timeout: 30000 },
  async (t) => {
    const { launch } = await desktopFixture(t, 'chatgpt-browser')
    const desktop = await launch()
    const page = await desktop.firstWindow()
    await page.locator('#root > *').first().waitFor()
    await desktop.evaluate(({ shell }) => {
      process.chatgptOpened = []
      shell.openExternal = async (url) => {
        process.chatgptOpened.push(url)
      }
    })
    await page.evaluate(() =>
      window.electronAPI.openChatGPTUrl('https://chatgpt.com/settings/usage'),
    )
    for (const url of [
      'https://evil.example',
      'file:///C:/Windows',
      'https://chatgpt.com.evil.example/settings/usage',
    ])
      await assert.rejects(
        page.evaluate((value) => window.electronAPI.openChatGPTUrl(value), url),
        /不允许/,
      )
    assert.deepEqual(await desktop.evaluate(() => process.chatgptOpened), [
      'https://chatgpt.com/settings/usage',
    ])
    assert.equal(page.url().startsWith('app://desktop/'), true)
    const result = await page.evaluate(async () => {
      const response = await fetch(`${window.electronAPI.apiBaseUrl}/api/v1/model`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'model' }),
      })
      return { status: response.status, code: (await response.json()).error.code }
    })
    assert.deepEqual(result, { status: 409, code: 'auth_mode_disabled' })
  },
)

test(
  'Application menu exposes native settings, logs and development update feedback',
  { timeout: 30000 },
  async (t) => {
    const { profile, launch } = await desktopFixture(t, 'menu')
    const desktop = await launch()
    await desktop.firstWindow()
    const menu = await desktop.evaluate(({ Menu, BrowserWindow }) => {
      const menu = Menu.getApplicationMenu()
      return {
        checkUpdates: menu.getMenuItemById('check-for-updates').enabled,
        openLogs: menu.getMenuItemById('open-logs').enabled,
        launchAtLogin: menu.getMenuItemById('launch-at-login').enabled,
        launchAtLoginVisible: menu.getMenuItemById('launch-at-login').visible,
        wakeShortcutVisible: menu.getMenuItemById('wake-shortcut').visible,
        wakeShortcutChecked: menu.getMenuItemById('wake-shortcut').checked,
        visible:
          process.platform === 'darwin' || BrowserWindow.getAllWindows()[0].isMenuBarVisible(),
      }
    })
    assert.deepEqual(menu, {
      checkUpdates: true,
      openLogs: true,
      launchAtLogin: false,
      launchAtLoginVisible: process.platform === 'win32',
      wakeShortcutVisible: process.platform === 'win32',
      wakeShortcutChecked: false,
      visible: true,
    })
    const logsDirectory = await desktop.evaluate(async ({ Menu, shell }) => {
      const original = shell.openPath
      const opened = new Promise((resolve) => {
        shell.openPath = async (path) => {
          resolve(path)
          return ''
        }
      })
      try {
        Menu.getApplicationMenu().getMenuItemById('open-logs').click()
        return await opened
      } finally {
        shell.openPath = original
      }
    })
    assert.equal(logsDirectory, join(profile, 'logs'))
    const updateMessage = await desktop.evaluate(async ({ Menu, dialog }) => {
      const original = dialog.showMessageBox
      const shown = new Promise((resolve) => {
        dialog.showMessageBox = async (options) => {
          resolve(options.message)
          return { response: 0, checkboxChecked: false }
        }
      })
      try {
        Menu.getApplicationMenu().getMenuItemById('check-for-updates').click()
        return await shown
      } finally {
        dialog.showMessageBox = original
      }
    })
    assert.match(updateMessage, /开发模式不检查更新/)
  },
)

test(
  'Launch at login follows system settings and reports failed changes',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async (t) => {
    const { profile, launch: launchDesktop } = await desktopFixture(t, 'login')
    let desktop
    // Simulate system settings before menu creation; never modify the real registry.
    const bootstrap = join(profile, 'login-test.cjs')
    await writeFile(
      bootstrap,
      `
      const { app, Menu, dialog } = require('electron')
      const probe = process.loginProbe = {
        registered: true, enabled: true, writes: [], errors: [], failure: null
      }
      app.getLoginItemSettings = () => ({
        openAtLogin: probe.registered,
        executableWillLaunchAtLogin: probe.registered && probe.enabled
      })
      app.setLoginItemSettings = (settings) => {
        probe.writes.push(settings)
        if (probe.failure === 'throw') throw new Error('Simulated registry failure')
        if (probe.failure === 'noop') return
        probe.registered = settings.openAtLogin
        probe.enabled = true
      }
      dialog.showErrorBox = (title) => probe.errors.push(title)
      const packaged = Object.getOwnPropertyDescriptor(app, 'isPackaged')
      Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
      const setMenu = Menu.setApplicationMenu
      Menu.setApplicationMenu = (menu) => {
        Object.defineProperty(app, 'isPackaged', packaged)
        return setMenu(menu)
      }
      import(${JSON.stringify(pathToFileURL(join(root, 'out/main/index.js')).href)})
      `,
    )
    desktop = await launchDesktop(bootstrap)
    const page = await desktop.firstWindow()
    await page.locator('#root > *').first().waitFor()
    const result = await desktop.evaluate(({ app, Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu().getMenuItemById('launch-at-login')
      const probe = process.loginProbe
      const initial = { checked: item.checked, enabled: item.enabled, writes: probe.writes.length }
      const states = []
      item.click()
      states.push(item.checked)
      item.click()
      states.push(item.checked)
      // Task Manager can disable an entry while its Run key still exists.
      probe.enabled = false
      app.emit('browser-window-focus', {}, BrowserWindow.getAllWindows()[0])
      states.push(item.checked)
      item.click()
      states.push(item.checked)
      for (const failure of ['throw', 'noop']) {
        probe.failure = failure
        item.click()
        states.push(item.checked)
      }
      return { initial, states, writes: probe.writes, errors: probe.errors }
    })
    assert.deepEqual(result, {
      initial: { checked: true, enabled: true, writes: 0 },
      states: [false, true, false, true, true, true],
      writes: [false, true, true, false, false].map((openAtLogin) => ({ openAtLogin })),
      errors: ['无法修改开机启动', '无法修改开机启动'],
    })
  },
)

test(
  'Update downloads clear taskbar progress and listeners before prompting',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async (t) => {
    const { launch: launchDesktop } = await desktopFixture(t, 'update')
    let desktop
    desktop = await launchDesktop()
    const page = await desktop.firstWindow()
    await page.locator('#root > *').first().waitFor()

    // Simulate updater events without downloading or installing a release.
    for (const fail of [false, true, false]) {
      const result = await desktop.evaluate(async ({ app, Menu, BrowserWindow, dialog }, fail) => {
        const { createRequire } = process.getBuiltinModule('module')
        const { autoUpdater } = createRequire(process.cwd() + '/package.json')('electron-updater')
        const packaged = Object.getOwnPropertyDescriptor(app, 'isPackaged')
        const check = autoUpdater.checkForUpdates
        const download = autoUpdater.downloadUpdate
        const showMessageBox = dialog.showMessageBox
        const setProgressBar = BrowserWindow.prototype.setProgressBar
        const progress = []
        const before = autoUpdater.listenerCount('download-progress')
        Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
        BrowserWindow.prototype.setProgressBar = (value) => progress.push(value)
        autoUpdater.checkForUpdates = async () => ({
          isUpdateAvailable: true,
          updateInfo: { version: '2.0.0' },
        })
        autoUpdater.downloadUpdate = async () => {
          autoUpdater.emit('download-progress', { percent: 25 })
          autoUpdater.emit('download-progress', { percent: 75 })
          if (fail) throw new Error('Simulated download failure')
          return []
        }
        try {
          return await new Promise((resolve) => {
            dialog.showMessageBox = async (options) => {
              if (options.title === '应用更新') return { response: 0 }
              resolve({
                title: options.title,
                progress: [...progress],
                listenerDelta: autoUpdater.listenerCount('download-progress') - before,
              })
              return { response: 1 }
            }
            Menu.getApplicationMenu().getMenuItemById('check-for-updates').click()
          })
        } finally {
          Object.defineProperty(app, 'isPackaged', packaged)
          autoUpdater.checkForUpdates = check
          autoUpdater.downloadUpdate = download
          dialog.showMessageBox = showMessageBox
          BrowserWindow.prototype.setProgressBar = setProgressBar
        }
      }, fail)
      assert.deepEqual(result, {
        title: fail ? '更新下载失败' : '更新已就绪',
        progress: [2, 0.25, 0.75, -1],
        listenerDelta: 0,
      })
    }
  },
)

test('Native context menus follow the editing context', { timeout: 30000 }, async (t) => {
  const { launch: launchDesktop } = await desktopFixture(t, 'context-menu')
  let desktop
  desktop = await launchDesktop()
  const page = await desktop.firstWindow()
  page.setDefaultTimeout(5000)
  await page.waitForLoadState('load')
  await page.evaluate(() => {
    const fixture = window.document.createElement('section')
    fixture.innerHTML =
      '<textarea id="context-editor"></textarea><p id="context-text">Selected text</p><div id="context-blank"><br></div>'
    window.document.body.prepend(fixture)
  })
  // Capture native menus without showing an OS popup or changing the clipboard.
  const spy = await desktop.evaluateHandle(({ Menu, BrowserWindow }) => {
    const state = { popup: null }
    Menu.prototype.popup = function (options) {
      const window = BrowserWindow.getAllWindows()[0]
      state.popup = {
        items: this.items.map(({ role, type, enabled }) => ({ role, type, enabled })),
        correctTarget: options.window === window && options.frame === window.webContents.mainFrame,
      }
    }
    return state
  })
  async function rightClick(selector) {
    const [popup] = await Promise.all([
      desktop.evaluate(({ BrowserWindow }, state) => {
        state.popup = null
        return new Promise((resolve) => {
          BrowserWindow.getAllWindows()[0].webContents.once('context-menu', () => {
            resolve(state.popup)
          })
        })
      }, spy),
      page.locator(selector).click({ button: 'right', position: { x: 10, y: 10 } }),
    ])
    return popup
  }

  const empty = await rightClick('#context-editor')
  assert.equal(empty.correctTarget, true)
  assert.deepEqual(
    empty.items.filter(({ type }) => type !== 'separator').map(({ role }) => role.toLowerCase()),
    ['undo', 'redo', 'cut', 'copy', 'paste', 'selectall'],
  )
  assert.equal(empty.items.find(({ role }) => role === 'copy').enabled, false)
  assert.equal(empty.items.find(({ role }) => role === 'cut').enabled, false)

  await page.locator('#context-editor').fill('Editable text')
  await page.locator('#context-editor').press('ControlOrMeta+A')
  const selected = await rightClick('#context-editor')
  assert.equal(selected.items.find(({ role }) => role === 'copy').enabled, true)
  assert.equal(selected.items.find(({ role }) => role === 'cut').enabled, true)

  await page.evaluate(() => {
    window.getSelection().selectAllChildren(window.document.querySelector('#context-text'))
  })
  const text = await rightClick('#context-text')
  assert.equal(text.correctTarget, true)
  assert.deepEqual(text.items, [{ role: 'copy', type: 'normal', enabled: true }])

  await page.evaluate(() => window.getSelection().removeAllRanges())
  assert.equal(await rightClick('#context-blank'), null)
  await spy.dispose()
})
