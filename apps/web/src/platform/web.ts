import { isThemeSource } from '@learn-electron/contracts/native'
import type { ThemeSource } from '@learn-electron/contracts/native'
import type { Platform } from './contracts'

const themeKey = 'learn-electron.theme'
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
let theme: ThemeSource = 'system'

function applyTheme(): void {
  document.documentElement.classList.toggle(
    'dark',
    theme === 'dark' || (theme === 'system' && systemTheme.matches),
  )
}

export const webPlatform: Platform = {
  kind: 'web',
  apiBaseUrl: '',
  getTheme: () => {
    try {
      const stored = localStorage.getItem(themeKey)
      theme = isThemeSource(stored) ? stored : 'system'
    } catch {
      theme = 'system'
    }
    applyTheme()
    systemTheme.onchange = applyTheme
    return Promise.resolve(theme)
  },
  setTheme: (source) => {
    localStorage.setItem(themeKey, source)
    theme = source
    applyTheme()
    return Promise.resolve(source)
  },
}
