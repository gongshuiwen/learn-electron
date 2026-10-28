import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc'
import type { AppInfo } from '../shared/ipc'
import { readWindowState, saveWindowState } from './window-state'

const rendererURL =
  !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL).href
    : pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href

function isRendererURL(url: string): boolean {
  // Hash routes belong to the same page; keep the rest of the URL exact.
  return url.split('#', 1)[0] === rendererURL.split('#', 1)[0]
}

async function createWindow(): Promise<void> {
  const { maximized: wasMaximized, ...bounds } = readWindowState()
  const window = new BrowserWindow({
    ...bounds,
    minWidth: Math.min(640, bounds.width),
    minHeight: Math.min(560, bounds.height),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f5f4',
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
  console.error('Failed to start Electron:', error)
  app.exit(1)
}

app
  .whenReady()
  .then(async () => {
    // The template needs no browser permissions; allow specific ones when required.
    session.defaultSession.setPermissionCheckHandler(() => false)
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })

    ipcMain.handle(IPC_CHANNELS.getAppInfo, (event): AppInfo => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (
        !window ||
        event.senderFrame !== window.webContents.mainFrame ||
        !isRendererURL(event.senderFrame.url)
      ) {
        throw new Error('Unexpected IPC sender')
      }
      return {
        name: app.getName(),
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      }
    })

    await createWindow()

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
