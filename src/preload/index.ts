import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc'
import type { AppInfo, ElectronAPI, ThemeSource } from '../shared/ipc'

const api: ElectronAPI = {
  // The main-process handler returns AppInfo; Electron's invoke API itself is untyped.
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo) as Promise<AppInfo>,
  getTheme: () => ipcRenderer.invoke(IPC_CHANNELS.getTheme) as Promise<ThemeSource>,
  setTheme: (source) => ipcRenderer.invoke(IPC_CHANNELS.setTheme, source) as Promise<ThemeSource>,
}

contextBridge.exposeInMainWorld('electronAPI', api)
