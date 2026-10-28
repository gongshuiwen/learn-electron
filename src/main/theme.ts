import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, nativeTheme } from 'electron'
import { isThemeSource } from '../shared/ipc'
import type { ThemeSource } from '../shared/ipc'

export function readTheme(): ThemeSource {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(app.getPath('userData'), 'theme.json'), 'utf8'),
    )
    if (isThemeSource(value)) return value
  } catch {
    // First launch or unreadable preferences: follow the system theme.
  }
  return 'system'
}

export function setTheme(value: unknown): ThemeSource {
  if (!isThemeSource(value)) throw new Error('Invalid theme')
  const directory = app.getPath('userData')
  mkdirSync(directory, { recursive: true })
  // Only apply the selection after it has been saved successfully.
  writeFileSync(join(directory, 'theme.json'), JSON.stringify(value))
  nativeTheme.themeSource = value
  return value
}

export function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#0c0a09' : '#f5f5f4'
}
