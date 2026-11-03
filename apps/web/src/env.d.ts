import type { NativeBridge } from '@learn-electron/contracts/native'

declare global {
  interface Window {
    electronAPI?: NativeBridge
  }
}
