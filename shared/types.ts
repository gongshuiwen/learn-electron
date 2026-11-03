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

export interface TextFile {
  name: string
  content: string
}
