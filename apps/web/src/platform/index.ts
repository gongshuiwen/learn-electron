import type { Platform } from './contracts'
import { webPlatform } from './web'

const native = window.electronAPI
export const platform: Platform = native
  ? {
      kind: 'desktop',
      apiBaseUrl: native.apiBaseUrl,
      getTheme: () => native.getTheme(),
      setTheme: (value) => native.setTheme(value),
    }
  : webPlatform

if (platform.kind === 'desktop') {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const update = () => document.documentElement.classList.toggle('dark', media.matches)
  update()
  media.addEventListener('change', update)
}
