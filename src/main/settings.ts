import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { isThemeSource } from '../shared/ipc'
import type { ThemeSource } from '../shared/ipc'

interface AppSettings {
  theme: ThemeSource
}

const defaults: AppSettings = { theme: 'system' }

export function readSettings(): AppSettings {
  try {
    const settings: unknown = JSON.parse(
      readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8'),
    )
    return {
      theme:
        settings &&
        typeof settings === 'object' &&
        'theme' in settings &&
        isThemeSource(settings.theme)
          ? settings.theme
          : defaults.theme,
    }
  } catch {
    // Missing, unreadable or malformed preferences must not block startup.
    return { ...defaults }
  }
}

export function saveSettings(settings: AppSettings): void {
  const directory = app.getPath('userData')
  mkdirSync(directory, { recursive: true })
  const temporaryPath = join(directory, `settings.${process.pid}.tmp`)
  try {
    writeFileSync(temporaryPath, JSON.stringify(settings, null, 2) + '\n')
    renameSync(temporaryPath, join(directory, 'settings.json'))
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}
