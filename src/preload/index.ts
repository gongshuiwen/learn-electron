import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc'
import type { ElectronAPI } from '../shared/ipc'

const api: ElectronAPI = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
}

contextBridge.exposeInMainWorld('electronAPI', api)
