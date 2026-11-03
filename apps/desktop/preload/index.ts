import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc'
import type { NativeBridge, ThemeSource } from '@learn-electron/contracts/native'

const api: NativeBridge = {
  apiBaseUrl: 'app://desktop',
  getTheme: () => ipcRenderer.invoke(IPC_CHANNELS.getTheme) as Promise<ThemeSource>,
  setTheme: (source) => ipcRenderer.invoke(IPC_CHANNELS.setTheme, source) as Promise<ThemeSource>,
}

contextBridge.exposeInMainWorld('electronAPI', api)
