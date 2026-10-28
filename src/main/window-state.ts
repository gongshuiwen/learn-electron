import { screen } from 'electron'
import type { Rectangle } from 'electron'
import Store from 'electron-store'

interface WindowState extends Rectangle {
  maximized: boolean
}

let store: Store<WindowState> | undefined

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
    store ??= new Store<WindowState>({
      name: 'window-state',
      defaults: state,
      schema: {
        x: { type: 'integer' },
        y: { type: 'integer' },
        width: { type: 'integer', minimum: 1 },
        height: { type: 'integer', minimum: 1 },
        maximized: { type: 'boolean' },
      },
      clearInvalidConfig: true,
    })
    state = store.store
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
    // Initialization happens during readWindowState; skip if storage was unavailable.
    store?.set(state)
  } catch (error) {
    console.warn('Unable to save window state:', error)
  }
}
