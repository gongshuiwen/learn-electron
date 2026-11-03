import type { NativeBridge } from '@learn-electron/contracts/native'

export interface Platform extends NativeBridge {
  kind: 'desktop' | 'web'
}
