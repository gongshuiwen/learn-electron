import type { ElectronAPI } from '../shared/ipc'

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
  interface ImportMetaEnv {
    readonly APP_NAME: string
    readonly APP_VERSION: string
  }
}
