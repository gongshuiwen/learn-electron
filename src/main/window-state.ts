import { screen } from 'electron'
import type { BaseWindow, Rectangle } from 'electron'
import Store from 'electron-store'
import log from 'electron-log/main'

interface WindowState extends Rectangle {
  maximized: boolean
}

let store: Store<WindowState> | undefined

function defaultBounds(area: Rectangle): Rectangle {
  const width = Math.min(1080, area.width)
  const height = Math.min(760, area.height)
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  }
}

export function readWindowState(): WindowState {
  let state: WindowState = {
    ...defaultBounds(screen.getPrimaryDisplay().workArea),
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

export function applyWindowBounds(window: BaseWindow, bounds: Rectangle): void {
  window.setMinimumSize(Math.min(640, bounds.width), Math.min(560, bounds.height))
  window.setBounds(bounds)
  // Native rounding can extend the right/bottom edge past the work area at fractional DPI.
  const area = screen.getDisplayMatching(bounds).workArea
  const actual = window.getBounds()
  const width = bounds.width - Math.max(0, actual.x + actual.width - area.x - area.width)
  const height = bounds.height - Math.max(0, actual.y + actual.height - area.y - area.height)
  if (width !== bounds.width || height !== bounds.height) {
    window.setMinimumSize(Math.min(640, width), Math.min(560, height))
    window.setBounds({ ...bounds, width, height })
  }
}

export function resetWindowLayout(window: BaseWindow): void {
  if (window.isFullScreen()) {
    window.once('leave-full-screen', () => resetWindowLayout(window))
    window.setFullScreen(false)
    return
  }
  const area = screen.getDisplayMatching(window.getBounds()).workArea
  if (window.isMinimized()) window.restore()
  if (window.isMaximized()) window.unmaximize()
  applyWindowBounds(window, defaultBounds(area))
}

export function saveWindowState(state: WindowState): void {
  try {
    // Initialization happens during readWindowState; skip if storage was unavailable.
    store?.set(state)
  } catch (error) {
    log.warn('Unable to save window state:', error)
  }
}
