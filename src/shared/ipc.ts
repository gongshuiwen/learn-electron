export const IPC_CHANNELS = {
  getAppInfo: 'app:get-info',
  copyDiagnostics: 'app:copy-diagnostics',
  showNotification: 'app:show-notification',
  getTheme: 'theme:get',
  setTheme: 'theme:set',
  openTextFile: 'file:open-text',
  saveTextFile: 'file:save-text',
} as const

export type ThemeSource = 'system' | 'light' | 'dark'
export type NotificationResult = 'sent' | 'unsupported'

export function isThemeSource(value: unknown): value is ThemeSource {
  return value === 'system' || value === 'light' || value === 'dark'
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  os: string
  arch: string
}

export interface ElectronAPI {
  getAppInfo: () => Promise<AppInfo>
  copyDiagnostics: () => Promise<void>
  showNotification: (title: string, body: string) => Promise<NotificationResult>
  getTheme: () => Promise<ThemeSource>
  setTheme: (source: ThemeSource) => Promise<ThemeSource>
  openTextFile: (hasUnsavedChanges: boolean, droppedFile?: File) => Promise<TextFile | null>
  saveTextFile: (content: string) => Promise<string | null>
}

export interface TextFile {
  name: string
  content: string
}
