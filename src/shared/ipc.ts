export const IPC_CHANNELS = {
  getAppInfo: 'app:get-info',
} as const

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
}

export interface ElectronAPI {
  getAppInfo: () => Promise<AppInfo>
}
