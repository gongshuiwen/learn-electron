import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc'
import type { AppInfo, ElectronAPI, NotificationResult, TextFile, ThemeSource } from '../shared/ipc'

const api: ElectronAPI = {
  // The main-process handler returns AppInfo; Electron's invoke API itself is untyped.
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo) as Promise<AppInfo>,
  copyDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.copyDiagnostics) as Promise<void>,
  showNotification: (title, body) =>
    ipcRenderer.invoke(IPC_CHANNELS.showNotification, title, body) as Promise<NotificationResult>,
  getTheme: () => ipcRenderer.invoke(IPC_CHANNELS.getTheme) as Promise<ThemeSource>,
  setTheme: (source) => ipcRenderer.invoke(IPC_CHANNELS.setTheme, source) as Promise<ThemeSource>,
  openTextFile: (hasUnsavedChanges, droppedFile) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.openTextFile,
      hasUnsavedChanges,
      droppedFile === undefined ? undefined : webUtils.getPathForFile(droppedFile),
    ) as Promise<TextFile | null>,
  saveTextFile: (content) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveTextFile, content) as Promise<string | null>,
  showSavedFile: () => ipcRenderer.invoke(IPC_CHANNELS.showSavedFile) as Promise<void>,
}

contextBridge.exposeInMainWorld('electronAPI', api)
