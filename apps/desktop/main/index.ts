import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from 'electron'
import { isChatGPTUrl } from '@learn-electron/contracts/native'
import type { IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import { IPC_CHANNELS } from '../shared/ipc'
import { applyWindowBounds, readWindowState, saveWindowState } from './window-state'
import { setTheme, windowBackground } from './theme'
import { getSettingsStore } from './settings'
import { checkForAppUpdates } from './updater'
import { createApplicationMenu, createTray, registerContextMenu } from './menu'
import icon from '../../../build/icon.png?asset'
import windowsIcon from '../../../build/icon.ico?asset'
import { startBackend, type Backend } from './backend'
import { DESKTOP_ORIGIN, registerDesktopProtocol } from './protocol'

if (!app.requestSingleInstanceLock()) app.exit(0)

log.transports.file.resolvePathFn = () => join(app.getPath('userData'), 'logs', 'main.log')
log.transports.ipc.level = false

const rendererURL =
  !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL).href
    : `${DESKTOP_ORIGIN}/index.html`

let backend: Backend | undefined
let quitting = false

app.on('will-quit', (event) => {
  if (!backend || quitting) return
  event.preventDefault()
  quitting = true
  void backend.close().finally(() => {
    // A dead backend may close immediately; retry outside the current quit event.
    setImmediate(() => app.quit())
  })
})

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
    applyWindowBounds(window, bounds)
    if (wasMaximized) window.maximize()
    window.show()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => {
    if (!isRendererURL(event.url)) event.preventDefault()
  })
  window.webContents.on('will-prevent-unload', (event) => {
    // Preventing this event allows the pending close or reload to continue.
    const response = dialog.showMessageBoxSync(window, {
      type: 'question',
      title: '未保存修改',
      message: '有未保存的修改，是否放弃？',
      buttons: ['取消', '放弃修改'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response === 1) event.preventDefault()
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

function handleStartupError(error: unknown): void {
  log.error('Failed to start Electron:', error)
  void (backend?.close() ?? Promise.resolve()).finally(() => app.exit(1))
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

    ipcMain.handle(IPC_CHANNELS.getTheme, (event) => {
      validateSender(event)
      return nativeTheme.themeSource
    })
    ipcMain.handle(IPC_CHANNELS.setTheme, (event, source: unknown) => {
      validateSender(event)
      return setTheme(source)
    })
    ipcMain.handle(IPC_CHANNELS.openChatGPTUrl, async (event, value: unknown) => {
      validateSender(event)
      if (!isChatGPTUrl(value)) throw new Error('不允许的 ChatGPT 地址')
      await shell.openExternal(value)
    })
    createApplicationMenu()
    backend = await startBackend()
    registerDesktopProtocol(
      backend,
      join(import.meta.dirname, '../renderer'),
      !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined,
    )
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
