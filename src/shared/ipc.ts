export const IPC_CHANNELS = {
  getAppInfo: 'app:get-info',
  getTheme: 'theme:get',
  setTheme: 'theme:set',
  openTextFile: 'file:open-text',
  saveTextFile: 'file:save-text',
} as const

export type ThemeSource = 'system' | 'light' | 'dark'

export function isThemeSource(value: unknown): value is ThemeSource {
  return value === 'system' || value === 'light' || value === 'dark'
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
}

export interface ElectronAPI {
  getAppInfo: () => Promise<AppInfo>
  getTheme: () => Promise<ThemeSource>
  setTheme: (source: ThemeSource) => Promise<ThemeSource>
  openTextFile: () => Promise<TextFile | null>
  saveTextFile: (content: string) => Promise<string | null>
}

export interface TextFile {
  name: string
  content: string
}
