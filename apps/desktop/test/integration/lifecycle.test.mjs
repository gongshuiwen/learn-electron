import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import electronPath from 'electron'
import { desktopFixture, environment, manifest, root } from '../helpers/electron.mjs'

test(
  'Windows tray and wake shortcut restore windows and respect cancelled exits',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async (t) => {
    const { profile, launch: launchDesktop } = await desktopFixture(t, 'tray')
    let desktop
    // Capture the real native tray and menu before the application creates them.
    const bootstrap = join(profile, 'tray-test.cjs')
    const destroyedFile = join(profile, 'tray-destroyed.txt')
    await writeFile(
      bootstrap,
      `
      const { app, Tray, globalShortcut, dialog } = require('electron')
      const { writeFileSync } = require('node:fs')
      const shortcut = process.shortcutProbe = {
        callback: null, failure: null, requests: [], unregisters: [], errors: []
      }
      globalShortcut.register = (key, callback) => {
        shortcut.requests.push(key)
        if (shortcut.failure === 'throw') throw new Error('Simulated registration failure')
        if (shortcut.failure === 'occupied') return false
        shortcut.callback = callback
        return true
      }
      globalShortcut.unregister = (key) => {
        shortcut.unregisters.push(key)
        shortcut.callback = null
      }
      dialog.showErrorBox = (title) => shortcut.errors.push(title)
      const original = Tray.prototype.setContextMenu
      Tray.prototype.setContextMenu = function(menu) {
        process.trayProbe = { tray: this, menu }
        return original.call(this, menu)
      }
      app.on('quit', () => {
        writeFileSync(${JSON.stringify(destroyedFile)}, JSON.stringify({
          destroyed: process.trayProbe.tray.isDestroyed(),
          registered: !!shortcut.callback,
          unregisters: shortcut.unregisters
        }))
      })
      import(${JSON.stringify(pathToFileURL(join(root, 'out/main/index.js')).href)})
    `,
    )
    desktop = await launchDesktop(bootstrap)
    const page = await desktop.firstWindow()
    page.setDefaultTimeout(5000)
    await page.locator('#root > *').first().waitFor()
    assert.deepEqual(
      await desktop.evaluate(() =>
        process.trayProbe.menu.items
          .filter((item) => item.type !== 'separator')
          .map((item) => item.label),
      ),
      ['显示窗口', '隐藏窗口', '退出应用'],
    )
    const shortcutState = await desktop.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu().getMenuItemById('wake-shortcut')
      const probe = process.shortcutProbe
      const initial = { checked: item.checked, registrations: probe.requests.length }
      const failedStates = []
      for (const failure of ['occupied', 'throw']) {
        probe.failure = failure
        item.click()
        failedStates.push(item.checked)
      }
      probe.failure = null
      item.click()
      const enabled = item.checked && !!probe.callback
      item.click()
      const disabled = !item.checked && !probe.callback
      item.click()
      return {
        initial,
        failedStates,
        enabled,
        disabled,
        requests: probe.requests,
        errors: probe.errors,
        registered: item.checked && !!probe.callback,
      }
    })
    assert.deepEqual(shortcutState, {
      initial: { checked: false, registrations: 0 },
      failedStates: [false, false],
      enabled: true,
      disabled: true,
      requests: Array(4).fill('Ctrl+Alt+E'),
      errors: ['无法启用全局快捷键', '无法启用全局快捷键'],
      registered: true,
    })
    await page.evaluate(() => {
      window.trayTestValue = 'preserved'
    })
    await desktop.evaluate(() => process.trayProbe.menu.items[1].click())
    assert.equal(
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      false,
    )
    await desktop.evaluate(() => process.shortcutProbe.callback())
    assert.equal(
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      true,
    )
    await desktop.evaluate(() => process.trayProbe.menu.items[1].click())
    await desktop.evaluate(() => process.trayProbe.tray.emit('click', {}, {}, {}))
    assert.equal(
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      true,
    )
    assert.equal(await page.evaluate(() => window.trayTestValue), 'preserved')
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      await new Promise((resolve) => {
        window.once('minimize', resolve)
        window.minimize()
      })
      await new Promise((resolve) => {
        window.once('restore', resolve)
        process.trayProbe.menu.items[0].click()
      })
    })
    assert.equal(
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
      false,
    )
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      await new Promise((resolve) => {
        window.once('minimize', resolve)
        window.minimize()
      })
      await new Promise((resolve) => {
        window.once('restore', resolve)
        process.shortcutProbe.callback()
      })
    })
    assert.equal(
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
      false,
    )

    // A hidden window must become visible for the unsaved-change prompt.
    await page.evaluate(() => {
      window.addEventListener('beforeunload', (event) => {
        event.preventDefault()
        event.returnValue = ''
      })
    })
    await desktop.evaluate(async ({ BrowserWindow, dialog }) => {
      dialog.showMessageBoxSync = () => 0
      const window = BrowserWindow.getAllWindows()[0]
      process.trayProbe.menu.items[1].click()
      await new Promise((resolve) => {
        window.webContents.once('will-prevent-unload', () => resolve())
        process.trayProbe.menu.items[3].click()
      })
    })
    assert.equal(
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      true,
    )
    assert.equal(await desktop.evaluate(() => process.trayProbe.tray.isDestroyed()), false)
    assert.equal(await desktop.evaluate(() => !!process.shortcutProbe.callback), true)
    assert.equal(
      await page.evaluate(async () => {
        const response = await fetch(`${window.electronAPI.apiBaseUrl}/api/v1/meta`)
        return response.status
      }),
      200,
    )
    const exited = desktop.waitForEvent('close')
    await desktop.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = () => 1
      process.trayProbe.menu.items[3].click()
    })
    await exited
    assert.deepEqual(JSON.parse(await readFile(destroyedFile, 'utf8')), {
      destroyed: true,
      registered: false,
      unregisters: ['Ctrl+Alt+E', 'Ctrl+Alt+E'],
    })
  },
)

test(
  'Renderer recovery reloads the real page or leaves it intact and preserves the backend',
  { timeout: 30000 },
  async (t) => {
    const { profile, launch: launchDesktop } = await desktopFixture(t, 'recovery')
    let desktop
    desktop = await launchDesktop()
    const page = await desktop.firstWindow()
    await page.getByText('demo / deterministic', { exact: true }).waitFor()
    const probe = await desktop.evaluateHandle(({ BrowserWindow, dialog }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const state = { prompts: [], response: 0, loads: 0, original: dialog.showMessageBox }
      dialog.showMessageBox = async (parent, options) => {
        state.prompts.push({ correctParent: parent === window, ...options })
        return { response: state.response, checkboxChecked: false }
      }
      window.webContents.on('did-finish-load', () => {
        state.loads++
      })
      return state
    })
    // Drive the application's recovery boundary, independently of OS crash-report
    // delivery. The resulting reload, fresh renderer state and API calls are real.
    await desktop.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.emit(
        'render-process-gone',
        {},
        { reason: 'clean-exit', exitCode: 0 },
      )
    })
    assert.equal(await desktop.evaluate((_, state) => state.prompts.length, probe), 0)
    const reloaded = page.waitForEvent('load')
    await desktop.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.emit(
        'render-process-gone',
        {},
        { reason: 'crashed', exitCode: 1 },
      )
    })
    await reloaded
    await page.getByText('demo / deterministic', { exact: true }).waitFor()
    const prompts = await desktop.evaluate((_, state) => state.prompts, probe)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].correctParent, true)
    assert.deepEqual(prompts[0].buttons, ['重新加载', '暂不处理'])
    assert.equal(prompts[0].cancelId, 1)
    assert.match(prompts[0].detail, /未保存/)
    assert.equal(await page.evaluate(() => window.electronAPI.getTheme()), 'system')
    await page.evaluate(() => {
      window.recoveryValue = 'preserved'
    })
    await desktop.evaluate(({ BrowserWindow }, state) => {
      state.response = 1
      BrowserWindow.getAllWindows()[0].webContents.emit(
        'render-process-gone',
        {},
        { reason: 'crashed', exitCode: 1 },
      )
    }, probe)
    assert.equal(await desktop.evaluate((_, state) => state.prompts.length, probe), 2)
    assert.equal(await page.evaluate(() => window.recoveryValue), 'preserved')
    assert.equal(await desktop.evaluate((_, state) => state.loads, probe), 1)
    assert.equal(
      await page.evaluate(async () => {
        const response = await fetch(`${window.electronAPI.apiBaseUrl}/api/v1/meta`)
        return response.status
      }),
      200,
    )
    await desktop.evaluate(({ dialog }, state) => {
      dialog.showMessageBox = state.original
    }, probe)
    const log = await readFile(join(profile, 'logs/main.log'), 'utf8')
    assert.match(log, /Renderer process exited:/)
    assert.match(log, /reason:/)
    assert.match(log, /exitCode:/)
  },
)
test('A second instance restores the existing window and exits', { timeout: 30000 }, async (t) => {
  const { profile, launch: launchDesktop } = await desktopFixture(t, 'single-instance')
  let desktop
  desktop = await launchDesktop()
  await desktop.firstWindow()
  const pid = await desktop.evaluate(async ({ app, BrowserWindow }) => {
    if (!app.hasSingleInstanceLock()) throw new Error('Missing single-instance lock')
    const window = BrowserWindow.getAllWindows()[0]
    if (!window.isVisible()) await new Promise((resolve) => window.once('show', resolve))
    // Xvfb has no window manager to minimize a window.
    if (process.platform === 'linux') window.hide()
    else {
      await new Promise((resolve) => {
        window.once('minimize', resolve)
        window.minimize()
      })
    }
    return process.pid
  })

  // execFile rejects if the second process fails or stays running past the timeout.
  await promisify(execFile)(electronPath, [root, `--user-data-dir=${profile}`], {
    env: environment,
    timeout: 10000,
  })
  assert.deepEqual(
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows()
      const window = windows[0]
      if (window.isMinimized()) await new Promise((resolve) => window.once('restore', resolve))
      return { pid: process.pid, windows: windows.length, visible: window.isVisible() }
    }),
    { pid, windows: 1, visible: true },
  )
})

test('Startup failure is logged and exits with status 1', { timeout: 15000 }, async (t) => {
  const { profile } = await desktopFixture(t, 'failure')
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
  const log = await readFile(join(profile, 'logs', 'main.log'), 'utf8')
  assert.ok(log.includes(`Starting ${manifest.name} ${manifest.version}`))
  assert.match(log, /Failed to start Electron: Error:.*ERR_FILE_NOT_FOUND/)
})
