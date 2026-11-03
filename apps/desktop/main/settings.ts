import Store from 'electron-store'
import type { ThemeSource } from '@learn-electron/contracts/native'

interface AppSettings {
  theme: ThemeSource
}

let store: Store<AppSettings> | undefined

// First called after app.whenReady(), so initialization errors reach the startup handler.
export function getSettingsStore(): Store<AppSettings> {
  store ??= new Store<AppSettings>({
    name: 'settings',
    schema: {
      theme: { type: 'string', enum: ['system', 'light', 'dark'], default: 'system' },
    },
    clearInvalidConfig: true,
  })
  return store
}
