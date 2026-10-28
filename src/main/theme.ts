import { nativeTheme } from 'electron'
import { isThemeSource } from '../shared/ipc'
import type { ThemeSource } from '../shared/ipc'
import { saveSettings } from './settings'

export function setTheme(value: unknown): ThemeSource {
  if (!isThemeSource(value)) throw new Error('Invalid theme')
  // Only apply the selection after it has been saved successfully.
  saveSettings({ theme: value })
  nativeTheme.themeSource = value
  return value
}

export function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#0c0a09' : '#f5f5f4'
}
