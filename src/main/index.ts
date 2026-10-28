import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc'
import type { AppInfo } from '../shared/ipc'

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 640,
    minHeight: 560,
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

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

function handleStartupError(error: unknown): void {
  console.error('Failed to start Electron:', error)
  app.quit()
}

app
  .whenReady()
  .then(async () => {
    ipcMain.handle(IPC_CHANNELS.getAppInfo, (event): AppInfo => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window || event.senderFrame !== window.webContents.mainFrame) {
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
