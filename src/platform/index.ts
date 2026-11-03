import type { ElectronAPI } from '../../shared/ipc'
import type { Platform } from './contracts'
import { webPlatform } from './web'

function desktopPlatform(api: ElectronAPI): Platform {
  return {
    ...api,
    kind: 'desktop',
    async saveTextFile(content) {
      const name = await api.saveTextFile(content)
      return name === null ? null : { status: 'saved', name }
    },
  }
}

export const platform: Platform = window.electronAPI
  ? desktopPlatform(window.electronAPI)
  : webPlatform

if (platform.kind === 'desktop') {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const update = () => document.documentElement.classList.toggle('dark', media.matches)
  update()
  media.addEventListener('change', update)
}
