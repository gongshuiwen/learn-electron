import { join } from 'node:path'
import { release, type } from 'node:os'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  screen,
  session,
} from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import { IPC_CHANNELS } from '../shared/ipc'
import type { AppInfo } from '../shared/ipc'
import { readWindowState, saveWindowState } from './window-state'
import { setTheme, windowBackground } from './theme'
import { getSettingsStore } from './settings'
import { checkForAppUpdates } from './updater'
import { createApplicationMenu, createTray, registerContextMenu } from './menu'
import { confirmDiscardChanges, openTextFile, saveTextFile, showSavedFile } from './text-files'
import { showNotification } from './notifications'
import icon from '../../build/icon.png?asset'
import windowsIcon from '../../build/icon.ico?asset'

if (!app.requestSingleInstanceLock()) app.exit(0)

log.transports.file.resolvePathFn = () => join(app.getPath('userData'), 'logs', 'main.log')
log.transports.ipc.level = false

const rendererURL =
  !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL).href
    : pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href

function isRendererURL(url: string): boolean {
  // Hash routes belong to the same page; keep the rest of the URL exact.
  return url.split('#', 1)[0] === rendererURL.split('#', 1)[0]
}

function validateSender(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (
    !window ||
    event.senderFrame !== window.webContents.mainFrame ||
    !isRendererURL(event.senderFrame.url)
  ) {
    throw new Error('Unexpected IPC sender')
  }
  return window
}

async function createWindow(): Promise<void> {
  const { maximized: wasMaximized, ...bounds } = readWindowState()
  const window = new BrowserWindow({
    ...bounds,
    minWidth: Math.min(640, bounds.width),
    minHeight: Math.min(560, bounds.height),
    show: false,
    icon: process.platform === 'win32' ? windowsIcon : icon,
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  registerContextMenu(window)
  createTray(window, windowsIcon)

  let maximized = wasMaximized
  window.on('maximize', () => {
    maximized = true
  })
  window.on('unmaximize', () => {
    maximized = false
  })
  window.on('close', () => {
    saveWindowState({ ...window.getNormalBounds(), maximized })
  })
  window.once('ready-to-show', () => {
    // Reapply after native frame creation to avoid size drift at fractional DPI.
    window.setBounds(bounds)
    // Native rounding can still extend the right/bottom edge past the work area.
    const area = screen.getDisplayMatching(bounds).workArea
    const actual = window.getBounds()
    const width = bounds.width - Math.max(0, actual.x + actual.width - area.x - area.width)
    const height = bounds.height - Math.max(0, actual.y + actual.height - area.y - area.height)
    if (width !== bounds.width || height !== bounds.height) {
      window.setMinimumSize(Math.min(640, width), Math.min(560, height))
      window.setBounds({ ...bounds, width, height })
    }
    if (wasMaximized) window.maximize()
    window.show()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => {
    if (!isRendererURL(event.url)) event.preventDefault()
  })
  window.webContents.on('will-prevent-unload', (event) => {
    // Preventing this event allows the pending close or reload to continue.
    if (confirmDiscardChanges(window)) event.preventDefault()
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || window.isDestroyed()) return
    log.error('Renderer process exited:', details)
    void dialog
      .showMessageBox(window, {
        type: 'error',
        title: '页面异常退出',
        message: '页面遇到问题，是否重新加载？',
        detail: '未保存的内容可能已丢失。重新加载后可继续使用应用。',
        buttons: ['重新加载', '暂不处理'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0 && !window.isDestroyed()) window.webContents.reload()
      })
      .catch((error: unknown) => {
        log.error('Unable to recover renderer:', error)
      })
  })

  await window.loadURL(rendererURL)
}

function getAppInfo(): AppInfo {
  return {
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    os: `${type()} ${release()}`,
    arch: process.arch,
  }
}

function handleStartupError(error: unknown): void {
  log.error('Failed to start Electron:', error)
  app.exit(1)
}

app
  .whenReady()
  .then(async () => {
    log.info(`Starting ${app.getName()} ${app.getVersion()}`)
    if (process.platform === 'win32') {
      // Keep the packaged ID in sync with electron-builder.yml.
      app.setAppUserModelId(app.isPackaged ? 'com.example.learn-electron' : process.execPath)
    }
    nativeTheme.themeSource = getSettingsStore().get('theme')
    nativeTheme.on('updated', () => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.setBackgroundColor(windowBackground())
      }
    })
    // The template needs no browser permissions; allow specific ones when required.
    session.defaultSession.setPermissionCheckHandler(() => false)
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })

    ipcMain.handle(IPC_CHANNELS.getAppInfo, (event): AppInfo => {
      validateSender(event)
      return getAppInfo()
    })
    ipcMain.handle(IPC_CHANNELS.copyDiagnostics, (event) => {
      validateSender(event)
      const info = getAppInfo()
      return clipboard.writeText(
        [
          `应用: ${info.name} ${info.version}`,
          `Electron: ${info.electron}`,
          `Chromium: ${info.chrome}`,
          `Node.js: ${info.node}`,
          `系统: ${info.os}`,
          `架构: ${info.arch}`,
        ].join('\n'),
      )
    })
    ipcMain.handle(IPC_CHANNELS.showNotification, (event, title: unknown, body: unknown) =>
      showNotification(validateSender(event), title, body),
    )

    ipcMain.handle(IPC_CHANNELS.getTheme, (event) => {
      validateSender(event)
      return nativeTheme.themeSource
    })
    ipcMain.handle(IPC_CHANNELS.setTheme, (event, source: unknown) => {
      validateSender(event)
      return setTheme(source)
    })
    ipcMain.handle(
      IPC_CHANNELS.openTextFile,
      (event, hasUnsavedChanges: unknown, droppedPath: unknown) =>
        openTextFile(validateSender(event), hasUnsavedChanges, droppedPath),
    )
    ipcMain.handle(IPC_CHANNELS.saveTextFile, (event, content: unknown) =>
      saveTextFile(validateSender(event), content),
    )
    ipcMain.handle(IPC_CHANNELS.showSavedFile, (event) => showSavedFile(validateSender(event)))

    createApplicationMenu()
    await createWindow()
    app.on('second-instance', () => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) {
        void createWindow().catch(handleStartupError)
        return
      }
      if (window.isMinimized()) window.restore()
      window.show()
    })

    void checkForAppUpdates()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow().catch(handleStartupError)
      }
    })
  })
  .catch(handleStartupError)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
