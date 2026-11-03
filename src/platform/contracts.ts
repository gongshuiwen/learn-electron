import type { AppInfo, NotificationResult, TextFile, ThemeSource } from '../../shared/types'

export type ApplicationInfo = Pick<AppInfo, 'name' | 'version'> &
  Partial<Omit<AppInfo, 'name' | 'version'>>
export type SaveResult = { status: 'saved' | 'download-started'; name: string } | null
export type PlatformNotificationResult = NotificationResult | 'denied'

export interface Platform {
  kind: 'desktop' | 'web'
  getAppInfo: () => Promise<ApplicationInfo>
  copyDiagnostics: () => Promise<void>
  getTheme: () => Promise<ThemeSource>
  setTheme: (source: ThemeSource) => Promise<ThemeSource>
  openTextFile: (hasUnsavedChanges: boolean, droppedFile?: File) => Promise<TextFile | null>
  saveTextFile: (content: string, name: string) => Promise<SaveResult>
  showSavedFile?: () => Promise<void>
  showNotification: (title: string, body: string) => Promise<PlatformNotificationResult>
}
