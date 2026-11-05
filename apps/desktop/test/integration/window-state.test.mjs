import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { desktopFixture } from '../helpers/electron.mjs'

async function windowFixture(t) {
  const { profile, launch } = await desktopFixture(t, 'window')
  return {
    stateFile: join(profile, 'window-state.json'),
    async launch() {
      const desktop = await launch()
      await desktop.firstWindow()
      await desktop.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win.isVisible()) await new Promise((resolve) => win.once('show', resolve))
      })
      return desktop
    },
  }
}

test('Window state survives restart and layout reset', { timeout: 60000 }, async (t) => {
  const { stateFile, launch } = await windowFixture(t)
  let desktop = await launch()
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
  desktop = await launch()
  assert.deepEqual(
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getNormalBounds(),
    ),
    bounds,
  )

  const page = await desktop.firstWindow()
  await page.evaluate(() => {
    window.layoutTestValue = 'preserved'
  })
  let resetBounds
  for (const mode of process.platform === 'linux'
    ? ['normal']
    : ['normal', 'maximized', 'fullscreen']) {
    const result = await desktop.evaluate(async ({ BrowserWindow, Menu, screen }, mode) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (mode !== 'normal') {
        await new Promise((resolve) => {
          win.once(mode === 'maximized' ? 'maximize' : 'enter-full-screen', resolve)
          if (mode === 'maximized') win.maximize()
          else win.setFullScreen(true)
        })
      }
      const area = screen.getDisplayMatching(win.getBounds()).workArea
      const leftFullscreen = win.isFullScreen()
        ? new Promise((resolve) => win.once('leave-full-screen', resolve))
        : Promise.resolve()
      Menu.getApplicationMenu().getMenuItemById('reset-window-layout').click({}, win)
      await leftFullscreen
      return {
        area,
        bounds: win.getBounds(),
        maximized: win.isMaximized(),
        fullscreen: win.isFullScreen(),
      }
    }, mode)
    assert.equal(result.maximized, false)
    assert.equal(result.fullscreen, false)
    const { area, bounds: actual } = result
    assert.ok(Math.abs(actual.width - Math.min(1080, area.width)) <= 1)
    assert.ok(Math.abs(actual.height - Math.min(760, area.height)) <= 1)
    assert.ok(Math.abs(actual.x - (area.x + (area.width - actual.width) / 2)) <= 1)
    assert.ok(Math.abs(actual.y - (area.y + (area.height - actual.height) / 2)) <= 1)
    assert.equal(await page.evaluate(() => window.layoutTestValue), 'preserved')
    resetBounds = actual
  }
  await desktop.close()
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), {
    ...resetBounds,
    maximized: false,
  })
  desktop = await launch()
  assert.deepEqual(
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()),
    resetBounds,
  )
  await desktop.evaluate(({ BrowserWindow }, bounds) => {
    BrowserWindow.getAllWindows()[0].setBounds(bounds)
  }, bounds)

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
    desktop = await launch()
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
    desktop = await launch()
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
})

test('Window state recovers invalid files and display bounds', { timeout: 60000 }, async (t) => {
  const { stateFile, launch } = await windowFixture(t)
  let desktop = await launch()
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
    desktop = await launch()
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
  desktop = await launch()
  assert.deepEqual(
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getNormalBounds(),
    ),
    savedBounds,
  )
  await desktop.close()
})
