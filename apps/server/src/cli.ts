import { resolve } from 'node:path'
import { createServerProcess } from './lifecycle.ts'

const service = createServerProcess()

try {
  try {
    process.loadEnvFile(resolve('.env'))
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const port = Number(process.env.APP_PORT ?? '4318')
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('APP_PORT 必须是 0 至 65535 的整数')
  const server = await service.start({
    token: process.env.APP_API_TOKEN ?? '',
    dataDir: resolve(process.env.APP_DATA_DIR ?? '.data'),
    port,
  })
  if (server) {
    console.log(`Agent service listening at ${server.url} (${process.env.APP_ENGINE ?? 'pi'})`)
  }
} catch (error) {
  await service.shutdown(error)
}
