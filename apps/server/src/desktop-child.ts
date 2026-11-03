import { isRecord } from '@learn-electron/contracts'
import { createServerProcess } from './lifecycle.ts'

if (!process.send) throw new Error('桌面后端需要 IPC 通道')

// The supervisor supplies the environment; never read the launch folder's .env.
const service = createServerProcess(
  (message) =>
    new Promise<void>((done) => {
      if (process.connected) process.send?.({ type: 'error', message }, () => done())
      else done()
    }),
)

process.on('message', (value: unknown) => {
  if (!isRecord(value)) return
  if (value.type === 'shutdown') {
    void service.shutdown()
  } else if (
    value.type === 'start' &&
    typeof value.token === 'string' &&
    typeof value.dataDir === 'string'
  ) {
    void service.start({ token: value.token, dataDir: value.dataDir, port: 0 }).then((server) => {
      if (server && process.connected)
        process.send?.({ type: 'ready', url: server.url }, () => undefined)
    }, service.shutdown)
  }
})
process.once('disconnect', () => void service.shutdown())
