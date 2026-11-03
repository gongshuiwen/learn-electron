import type { AppInfo, NotificationResult, TextFile, ThemeSource } from './types'

export const IPC_CHANNELS = {
  getAppInfo: 'app:get-info',
  copyDiagnostics: 'app:copy-diagnostics',
  showNotification: 'app:show-notification',
  getTheme: 'theme:get',
  setTheme: 'theme:set',
  openTextFile: 'file:open-text',
  saveTextFile: 'file:save-text',
  showSavedFile: 'file:show-saved',
} as const

export interface ElectronAPI {
  getAppInfo: () => Promise<AppInfo>
  copyDiagnostics: () => Promise<void>
  showNotification: (title: string, body: string) => Promise<NotificationResult>
  getTheme: () => Promise<ThemeSource>
  setTheme: (source: ThemeSource) => Promise<ThemeSource>
  openTextFile: (hasUnsavedChanges: boolean, droppedFile?: File) => Promise<TextFile | null>
  saveTextFile: (content: string) => Promise<string | null>
  showSavedFile: () => Promise<void>
}
