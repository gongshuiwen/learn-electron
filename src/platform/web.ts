import { isThemeSource } from '../../shared/types'
import type { ThemeSource } from '../../shared/types'
import type { Platform } from './contracts'

const MAX_TEXT_BYTES = 1024 * 1024
const themeKey = 'learn-electron.theme'
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
let theme: ThemeSource = 'system'

function applyTheme(): void {
  document.documentElement.classList.toggle(
    'dark',
    theme === 'dark' || (theme === 'system' && systemTheme.matches),
  )
}

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.txt,.md,.json'
    input.hidden = true
    const finish = (file: File | null) => {
      input.remove()
      resolve(file)
    }
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => finish(null), { once: true })
    document.body.append(input)
    input.click()
  })
}

export const webPlatform: Platform = {
  kind: 'web',
  getAppInfo: () =>
    Promise.resolve({ name: import.meta.env.APP_NAME, version: import.meta.env.APP_VERSION }),
  copyDiagnostics: () =>
    navigator.clipboard.writeText(`应用: ${import.meta.env.APP_NAME} ${import.meta.env.APP_VERSION}
浏览器: ${navigator.userAgent}`),
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
  async openTextFile(hasUnsavedChanges, droppedFile) {
    if (hasUnsavedChanges && !window.confirm('有未保存的修改，是否放弃？')) return null
    const file = droppedFile ?? (await pickFile())
    if (!file) return null
    if (file.size > MAX_TEXT_BYTES) throw new Error('File exceeds 1 MiB')
    const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
    return { name: file.name, content }
  },
  saveTextFile: (content, name) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    if (blob.size > MAX_TEXT_BYTES) throw new Error('File exceeds 1 MiB')
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.append(link)
    try {
      link.click()
    } finally {
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60000)
    }
    return Promise.resolve({ status: 'download-started', name })
  },
  async showNotification(title, body) {
    if (!window.isSecureContext || !('Notification' in window)) return 'unsupported'
    const permission =
      Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission
    if (permission !== 'granted') return 'denied'
    const notification = new Notification(title, { body })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
    return 'sent'
  },
}
