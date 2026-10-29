import { Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import log from 'electron-log/main'
import type { NotificationResult } from '../shared/ipc'

// Retain the latest notification so its click handler survives native delivery.
let notification: Notification | undefined

export async function showNotification(
  window: BrowserWindow,
  title: unknown,
  body: unknown,
): Promise<NotificationResult> {
  if (typeof title !== 'string' || !title.trim() || typeof body !== 'string') {
    throw new Error('Expected a notification title and body')
  }
  if (!Notification.isSupported()) return 'unsupported'

  notification?.close()
  const current = new Notification({ title, body })
  notification = current
  current.once('click', () => {
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
  })

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      // Notification delivery events are not guaranteed on every desktop setup.
      timeout = setTimeout(() => reject(new Error('Notification delivery was not confirmed')), 5000)
      current.once('show', () => resolve())
      current.once('failed', (_event, error) => {
        log.warn('Unable to show system notification:', error)
        reject(new Error(error))
      })
      current.show()
    })
    return 'sent'
  } finally {
    clearTimeout(timeout)
  }
}
