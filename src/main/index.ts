import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, nativeTheme, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import { IPC_CHANNELS } from '../shared/ipc'
import type { AppInfo } from '../shared/ipc'
import { readWindowState, saveWindowState } from './window-state'
import { setTheme, windowBackground } from './theme'
import { getSettingsStore } from './settings'
import { checkForAppUpdates } from './updater'

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

function validateSender(event: IpcMainInvokeEvent): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (
    !window ||
    event.senderFrame !== window.webContents.mainFrame ||
    !isRendererURL(event.senderFrame.url)
  ) {
    throw new Error('Unexpected IPC sender')
  }
}

async function createWindow(): Promise<void> {
  const { maximized: wasMaximized, ...bounds } = readWindowState()
  const window = new BrowserWindow({
    ...bounds,
    minWidth: Math.min(640, bounds.width),
    minHeight: Math.min(560, bounds.height),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

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
    if (wasMaximized) window.maximize()
    window.show()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => {
    if (!isRendererURL(event.url)) event.preventDefault()
  })

  await window.loadURL(rendererURL)
}

function handleStartupError(error: unknown): void {
  log.error('Failed to start Electron:', error)
  app.exit(1)
}

app
  .whenReady()
  .then(async () => {
    log.info(`Starting ${app.getName()} ${app.getVersion()}`)
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
      return {
        name: app.getName(),
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      }
    })

    ipcMain.handle(IPC_CHANNELS.getTheme, (event) => {
      validateSender(event)
      return nativeTheme.themeSource
    })
    ipcMain.handle(IPC_CHANNELS.setTheme, (event, source: unknown) => {
      validateSender(event)
      return setTheme(source)
    })

    await createWindow()
    void checkForAppUpdates().catch((error: unknown) => {
      log.error('Unable to check for application updates:', error)
    })

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
