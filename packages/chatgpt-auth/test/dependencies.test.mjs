import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('dependency boundaries cover package subpaths without blocking allowed imports', async (t) => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-auth-boundary-'))
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('chatgpt-auth-boundary-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
  })
  const config = JSON.parse(await readFile(join(root, '.oxlintrc.json'), 'utf8'))
  // The import rule does not need TypeScript type information in this isolated fixture.
  config.options.typeAware = false
  const configPath = join(directory, '.oxlintrc.json')
  await writeFile(configPath, JSON.stringify(config))
  function lint(source) {
    return spawnSync(
      process.execPath,
      [join(root, 'node_modules/oxlint/bin/oxlint'), '-c', configPath, '-f', 'json', source],
      {
        cwd: directory,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
      },
    )
  }
  const cases = [
    {
      path: 'packages/chatgpt-auth/src/probe.ts',
      allowed: ['node:http', 'jose'],
      blocked: [
        '@earendil-works/pi-ai',
        '@earendil-works/pi-ai/providers/openai',
        '@learn-electron/model-connections',
        '@learn-electron/contracts/chatgpt',
        'electron/main/internal',
        'react/jsx-runtime',
        'react-dom/client/internal',
      ],
    },
    {
      path: 'apps/server/src/model-service.ts',
      allowed: ['@learn-electron/model-connections', '@learn-electron/contracts/models'],
      blocked: [
        '@earendil-works/pi-ai/providers/openai',
        '@learn-electron/chatgpt-auth',
        '@learn-electron/chatgpt-auth/internal',
        './chatgpt/provider.ts',
      ],
    },
    {
      path: 'packages/agent-runtime/src/probe.ts',
      allowed: ['@earendil-works/pi-ai/providers/openai', '@learn-electron/model-connections'],
      blocked: [
        '@learn-electron/chatgpt-auth',
        '@learn-electron/contracts/chatgpt',
        'react/jsx-runtime',
      ],
    },
    {
      path: 'apps/web/src/probe.tsx',
      allowed: ['@learn-electron/contracts/models'],
      blocked: [
        '@earendil-works/pi-ai/providers/openai',
        '@learn-electron/chatgpt-auth/internal',
        'node:fs/promises',
      ],
    },
    {
      path: 'apps/desktop/probe.ts',
      allowed: ['@learn-electron/contracts/native'],
      blocked: ['@earendil-works/pi-ai/providers/openai', '@learn-electron/chatgpt-auth/internal'],
    },
    {
      path: 'packages/model-connections/src/probe.ts',
      allowed: ['./model.ts'],
      blocked: [
        'node:fs/promises',
        'electron/main/internal',
        'react/jsx-runtime',
        'react-dom/client/internal',
        '@earendil-works/pi-ai/providers/openai',
        '@learn-electron/contracts/chatgpt',
      ],
    },
  ]
  for (const { path, allowed, blocked } of cases) {
    const source = join(directory, path)
    await mkdir(dirname(source), { recursive: true })
    const imports = (names) =>
      `${names.map((name, i) => `import * as item${i} from '${name}'`).join('\n')}\nconsole.log(${names.map((_, i) => `item${i}`).join(', ')})\n`
    await writeFile(source, imports(allowed))
    const permitted = lint(source)
    assert.ifError(permitted.error)
    assert.equal(permitted.status, 0, permitted.stdout + permitted.stderr)
    await writeFile(source, imports(blocked))
    const denied = lint(source)
    assert.ifError(denied.error)
    assert.equal(denied.status, 1, denied.stdout + denied.stderr)
    for (const name of blocked)
      assert.ok(denied.stdout.includes(`'${name}'`), `${path}: import was not rejected: ${name}`)
  }
})
