import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

export const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))
export const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
export const environment = {
  ...process.env,
  APP_ENGINE: 'mock',
  APP_NODE_EXECUTABLE: process.execPath,
}
delete environment.ELECTRON_RUN_AS_NODE
delete environment.ELECTRON_RENDERER_URL

// Every scenario owns its profile and process, including across application restarts.
export async function desktopFixture(t, name) {
  const profile = await mkdtemp(join(tmpdir(), `learn-electron-${name}-`))
  let desktop
  t.after(async () => {
    try {
      await desktop?.close()
    } finally {
      assert.equal(dirname(resolve(profile)), resolve(tmpdir()))
      assert.ok(basename(profile).startsWith(`learn-electron-${name}-`))
      await rm(profile, { recursive: true, force: true })
    }
  })
  return {
    profile,
    async launch(entry = root) {
      desktop = await electron.launch({
        args: [entry, `--user-data-dir=${profile}`],
        cwd: root,
        chromiumSandbox: true,
        env: environment,
        timeout: 15000,
      })
      return desktop
    },
  }
}
