import { join } from 'node:path'
import { lock } from 'proper-lockfile'

/** Acquire before opening SQLite or any Pi session; only one service owns them. */
export async function acquireDataDirectory(directory: string): Promise<() => Promise<void>> {
  try {
    return await lock(directory, {
      lockfilePath: join(directory, '.service.lock'),
      stale: 5000,
      update: 1000,
      retries: { retries: 6, factor: 1, minTimeout: 1000, maxTimeout: 1000, randomize: false },
      // Keep proper-lockfile's fail-fast default onCompromised behavior. Once
      // ownership is lost, graceful cleanup could write into another owner's
      // sessions; the process must stop instead of continuing with stale state.
    })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ELOCKED') {
      throw new Error('数据目录已被另一个服务使用，请停止该服务或指定不同的 APP_DATA_DIR', {
        cause: error,
      })
    }
    throw error
  }
}
