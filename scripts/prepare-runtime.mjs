import { copyFile, mkdir, chmod, writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { serverDependencies } from './server-dependencies.mjs'

if (process.versions.electron) throw new Error('Prepare the server runtime using Node.js')
const directory = fileURLToPath(new URL('../out/runtime/', import.meta.url))
await mkdir(directory, { recursive: true })
const target = join(directory, process.platform === 'win32' ? 'node.exe' : 'node')
await copyFile(process.execPath, target)
if (process.platform !== 'win32') await chmod(target, 0o755)

let license
try {
  license = await readFile(join(dirname(process.execPath), 'LICENSE'), 'utf8')
} catch {
  const response = await fetch(
    `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
  )
  if (!response.ok) throw new Error('Unable to obtain the bundled Node.js license')
  license = await response.text()
}
await writeFile(join(directory, 'LICENSE'), license)

// A standard Node process cannot read Electron ASAR archives. Ship a self-contained
// server directory, with its production dependencies, outside the archive.
const server = fileURLToPath(new URL('../out/server/', import.meta.url))
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
const manifest = {
  name: 'learn-electron-server',
  version: lock.version,
  private: true,
  type: 'module',
  dependencies: serverDependencies,
}
// Reuse resolved third-party versions from the repository lock. Workspace source
// is already bundled, so its filesystem links do not belong in the delivery tree.
lock.name = manifest.name
lock.packages = Object.fromEntries(
  Object.entries(lock.packages).filter(
    ([path, entry]) => path.startsWith('node_modules/') && !entry.link,
  ),
)
lock.packages[''] = manifest
await writeFile(join(server, 'package.json'), JSON.stringify(manifest, null, 2))
await writeFile(join(server, 'package-lock.json'), JSON.stringify(lock, null, 2))
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run prepare:runtime through npm')
// The shared lock includes other workspaces' production packages. Install the
// pinned graph first, then prune packages not reachable from the server manifest.
for (const command of ['ci', 'prune']) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        npm,
        command,
        '--prefix',
        server,
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { stdio: 'inherit', windowsHide: true },
    )
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Server dependency ${command} failed (${code})`)),
    )
  })
}
