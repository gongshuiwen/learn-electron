import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc'
import type { AppInfo, ElectronAPI } from '../shared/ipc'

const api: ElectronAPI = {
  // The main-process handler returns AppInfo; Electron's invoke API itself is untyped.
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo) as Promise<AppInfo>,
}

contextBridge.exposeInMainWorld('electronAPI', api)
