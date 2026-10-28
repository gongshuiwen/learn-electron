import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, screen } from 'electron'
import type { Rectangle } from 'electron'

interface WindowState extends Rectangle {
  maximized: boolean
}

export function readWindowState(): WindowState {
  const primary = screen.getPrimaryDisplay().workArea
  let state: WindowState = {
    x: primary.x + Math.round((primary.width - 1080) / 2),
    y: primary.y + Math.round((primary.height - 760) / 2),
    width: 1080,
    height: 760,
    maximized: false,
  }

  try {
    const saved = JSON.parse(
      readFileSync(join(app.getPath('userData'), 'window-state.json'), 'utf8'),
    ) as Partial<WindowState> | null
    if (
      saved &&
      [saved.x, saved.y, saved.width, saved.height].every(Number.isSafeInteger) &&
      typeof saved.width === 'number' &&
      saved.width > 0 &&
      typeof saved.height === 'number' &&
      saved.height > 0 &&
      typeof saved.maximized === 'boolean'
    ) {
      state = saved as WindowState
    }
  } catch {
    // Missing or unreadable state must not prevent the app from starting.
  }

  const area = screen.getDisplayMatching(state).workArea
  const width = Math.min(Math.max(state.width, 640), area.width)
  const height = Math.min(Math.max(state.height, 560), area.height)
  return {
    x: Math.max(area.x, Math.min(state.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(state.y, area.y + area.height - height)),
    width,
    height,
    maximized: state.maximized,
  }
}

export function saveWindowState(state: WindowState): void {
  try {
    const directory = app.getPath('userData')
    mkdirSync(directory, { recursive: true })
    // A small synchronous write on close finishes before Electron exits.
    writeFileSync(join(directory, 'window-state.json'), JSON.stringify(state))
  } catch (error) {
    console.warn('Unable to save window state:', error)
  }
}
