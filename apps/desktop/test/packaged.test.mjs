import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { _electron as electron } from 'playwright-core'

const root = fileURLToPath(new URL('../../../', import.meta.url))

test(
  'packaged Windows application owns its runtime, restores chat and stops its server',
  {
    skip: process.platform !== 'win32',
    timeout: 120_000,
  },
  async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'pi-chat-packaged-'))
    const standalone = await mkdtemp(join(tmpdir(), 'pi-chat-application-'))
    const executablePath = join(standalone, 'Learn Electron.exe')
    let desktop
    t.after(async () => {
      await desktop?.close()
      await rm(profile, { recursive: true, force: true })
      await rm(standalone, { recursive: true, force: true, maxRetries: 5 })
    })
    // Run outside the repository so a missing delivery dependency cannot resolve
    // through the development workspace's node_modules directory.
    await cp(join(root, 'dist/win-unpacked'), standalone, { recursive: true })
    async function launch(engine = 'mock') {
      const environment = {
        ...process.env,
        APP_ENGINE: engine,
        PI_PROVIDER: '__missing_provider__',
        PI_MODEL: '__missing_model__',
        // Neither a system Node nor this development override may be required.
        APP_NODE_EXECUTABLE: 'missing-node-executable',
        PATH: join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
        NODE_PATH: '',
      }
      delete environment.ELECTRON_RUN_AS_NODE
      delete environment.ELECTRON_RENDERER_URL
      desktop = await electron.launch({
        executablePath,
        args: [`--user-data-dir=${profile}`],
        env: environment,
        timeout: 20_000,
      })
      let page
      try {
        page = await desktop.firstWindow()
      } catch (error) {
        console.error(
          await readFile(join(profile, 'logs/main.log'), 'utf8').catch(() => 'No application log'),
        )
        throw error
      }
      page.setDefaultTimeout(10_000)
      await page.getByRole('textbox', { name: '发送消息', exact: true }).waitFor()
      return page
    }
    let page = await launch()
    assert.equal(await desktop.evaluate(({ app }) => app.isPackaged), true)
    await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('安装包独立运行验证')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await page.getByText('演示回复：安装包独立运行验证', { exact: true }).waitFor()
    await page.getByRole('button', { name: '发送消息', exact: true }).waitFor()
    await mkdir(join(root, '.cache'), { recursive: true })
    await page.screenshot({ path: join(root, '.cache/packaged-chat.png'), fullPage: true })
    const log = await readFile(join(profile, 'logs/main.log'), 'utf8')
    const pid = Number(/Local server ready:\s+(\d+)/.exec(log)?.[1])
    assert.ok(pid > 0)
    await desktop.close()
    desktop = undefined
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    // Also load the real Pi adapter from staged production dependencies, offline.
    page = await launch('pi')
    await page.getByText('演示回复：安装包独立运行验证', { exact: true }).waitFor()
    const meta = await page.evaluate(async () => {
      const response = await fetch(`${window.electronAPI.apiBaseUrl}/api/v1/meta`)
      return response.json()
    })
    assert.equal(meta.engine, 'pi')
    assert.equal(meta.configured, false)
  },
)
