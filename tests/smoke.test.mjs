import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  await page.waitForLoadState('load')
  await page.locator('#root > *').first().waitFor()

  const info = await page.evaluate(() => window.electronAPI.getAppInfo())
  assert.equal(info.name, manifest.name)
  assert.equal(info.version, manifest.version)
  for (const key of ['electron', 'chrome', 'node']) assert.match(info[key], /^\d+\.\d+\.\d+/)
  assert.deepEqual(
    await page.evaluate(() => ({
      require: typeof window.require,
      process: typeof window.process,
      getAppInfo: typeof window.electronAPI.getAppInfo,
    })),
    { require: 'undefined', process: 'undefined', getAppInfo: 'function' },
  )
  const preferences = await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  )
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.nodeIntegration, false)
  const menu = await desktop.evaluate(({ Menu, BrowserWindow }) => {
    const menu = Menu.getApplicationMenu()
    return {
      checkUpdates: menu.getMenuItemById('check-for-updates').enabled,
      openLogs: menu.getMenuItemById('open-logs').enabled,
      visible: process.platform === 'darwin' || BrowserWindow.getAllWindows()[0].isMenuBarVisible(),
    }
  })
  assert.deepEqual(menu, { checkUpdates: true, openLogs: true, visible: true })
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
  assert.equal(await page.evaluate(() => window.Notification.permission), 'denied')
  assert.equal(await page.evaluate(() => window.Notification.requestPermission()), 'denied')
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content')
  assert.ok(!csp.includes('unsafe-inline'))

  await page.evaluate(() => {
    window.location.hash = '/settings'
  })
  assert.equal((await page.evaluate(() => window.electronAPI.getAppInfo())).name, manifest.name)

  // Only the fragment may vary; a changed query must still fail the sender check.
  const routeURL = page.url()
  await page.evaluate(() => window.history.replaceState(null, '', '?untrusted=1#/settings'))
  await assert.rejects(
    page.evaluate(() => window.electronAPI.getAppInfo()),
    /Unexpected IPC sender/,
  )
  await page.evaluate((url) => window.history.replaceState(null, '', url), routeURL)

  // Exercise the same reload used by the error boundary, with a hash route present.
  const reloaded = page.waitForEvent('load')
  await page.evaluate(() => window.location.reload())
  await reloaded
  assert.equal(page.url(), routeURL)
  await page.locator('#root > *').first().waitFor()
  assert.equal((await page.evaluate(() => window.electronAPI.getAppInfo())).name, manifest.name)
  assert.deepEqual(errors, [])
})

test('A second instance restores the existing window and exits', { timeout: 30000 }, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'learn-electron-single-instance-'))
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

test('Window state survives restart and recovers invalid files', { timeout: 60000 }, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'learn-electron-window-'))
  const stateFile = join(profile, 'window-state.json')
  let desktop
  t.after(async () => {
    try {
      await desktop?.close()
    } finally {
      await rm(profile, { recursive: true, force: true })
    }
  })
  async function launch() {
    desktop = await electron.launch({
      args: [root, `--user-data-dir=${profile}`],
      cwd: root,
      chromiumSandbox: true,
      env: environment,
      timeout: 15000,
    })
    await desktop.firstWindow()
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win.isVisible()) await new Promise((resolve) => win.once('show', resolve))
    })
  }

  await launch()
  const edgeStates = await desktop.evaluate(({ screen }) =>
    screen.getAllDisplays().map(({ workArea: area }) => {
      const width = Math.min(800, area.width)
      const height = Math.min(600, area.height)
      return {
        x: area.x + area.width - width,
        y: area.y + area.height - height,
        width,
        height,
        maximized: false,
      }
    }),
  )
  const bounds = await desktop.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const area = screen.getPrimaryDisplay().workArea
    win.setBounds({
      x: area.x + 20,
      y: area.y + 20,
      width: Math.min(800, area.width - 20),
      height: Math.min(600, area.height - 20),
    })
    return win.getNormalBounds()
  })
  await desktop.close()
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { ...bounds, maximized: false })
  await launch()
  assert.deepEqual(
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getNormalBounds(),
    ),
    bounds,
  )

  // Headless Xvfb has no window manager to perform maximize/minimize operations.
  if (process.platform !== 'linux') {
    await desktop.evaluate(
      ({ BrowserWindow }) =>
        new Promise((resolve) => {
          const win = BrowserWindow.getAllWindows()[0]
          win.once('maximize', resolve)
          win.maximize()
        }),
    )
    await desktop.evaluate(
      ({ BrowserWindow }) =>
        new Promise((resolve) => {
          const win = BrowserWindow.getAllWindows()[0]
          win.once('minimize', resolve)
          win.minimize()
        }),
    )
    await desktop.close()
    assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { ...bounds, maximized: true })
    await launch()
    assert.equal(
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()),
      true,
    )
    await desktop.evaluate(
      ({ BrowserWindow }) =>
        new Promise((resolve) => {
          const win = BrowserWindow.getAllWindows()[0]
          win.once('unmaximize', resolve)
          win.unmaximize()
        }),
    )
    assert.deepEqual(
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()),
      bounds,
    )
    await desktop.evaluate(
      ({ BrowserWindow }) =>
        new Promise((resolve) => {
          const win = BrowserWindow.getAllWindows()[0]
          win.once('minimize', resolve)
          win.minimize()
        }),
    )
    await desktop.close()
    await launch()
    assert.equal(
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
      false,
    )
    assert.deepEqual(
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getNormalBounds(),
      ),
      bounds,
    )
  }
  await desktop.close()

  for (const contents of [
    '{broken',
    '{"width": "invalid"}',
    ...edgeStates.map((state) => JSON.stringify(state)),
    JSON.stringify({
      x: 100000,
      y: -100000,
      width: 10000,
      height: 10000,
      maximized: false,
    }),
  ]) {
    await writeFile(stateFile, contents)
    await launch()
    const { bounds: restored, area } = await desktop.evaluate(({ BrowserWindow, screen }) => {
      const bounds = BrowserWindow.getAllWindows()[0].getNormalBounds()
      return { bounds, area: screen.getDisplayMatching(bounds).workArea }
    })
    assert.ok(restored.width > 0 && restored.height > 0)
    assert.ok(restored.x >= area.x && restored.y >= area.y)
    assert.ok(
      restored.x + restored.width <= area.x + area.width,
      JSON.stringify({ restored, area }),
    )
    assert.ok(
      restored.y + restored.height <= area.y + area.height,
      JSON.stringify({ restored, area }),
    )
    await desktop.close()
  }

  // A corrected size must remain stable instead of shrinking on every restart.
  const savedBounds = JSON.parse(await readFile(stateFile, 'utf8'))
  delete savedBounds.maximized
  await launch()
  assert.deepEqual(
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getNormalBounds(),
    ),
    savedBounds,
  )
  await desktop.close()
})

test(
  'Theme selection follows native colors, persists and validates IPC',
  { timeout: 45000 },
  async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'learn-electron-theme-'))
    const settingsFile = join(profile, 'settings.json')
    let desktop
    t.after(async () => {
      try {
        await desktop?.close()
      } finally {
        await rm(profile, { recursive: true, force: true })
      }
    })
    async function launch() {
      desktop = await electron.launch({
        args: [root, `--user-data-dir=${profile}`],
        cwd: root,
        chromiumSandbox: true,
        env: environment,
        timeout: 15000,
      })
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
    const trustedURL = page.url()
    await page.evaluate(() => window.history.replaceState(null, '', '?untrusted=1'))
    await assert.rejects(
      page.evaluate(() => window.electronAPI.getTheme()),
      /Unexpected IPC sender/,
    )
    await assert.rejects(
      page.evaluate(() => window.electronAPI.setTheme('dark')),
      /Unexpected IPC sender/,
    )
    await page.evaluate((url) => window.history.replaceState(null, '', url), trustedURL)

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

test('Startup failure is logged and exits with status 1', { timeout: 15000 }, async (t) => {
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
  const log = await readFile(join(profile, 'logs', 'main.log'), 'utf8')
  assert.ok(log.includes(`Starting ${manifest.name} ${manifest.version}`))
  assert.match(log, /Failed to start Electron: Error:.*ERR_FILE_NOT_FOUND/)
})
