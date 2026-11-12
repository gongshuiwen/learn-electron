import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { checkServerModules } from '../check-server-modules.mjs'

async function fixture(t, sources) {
  const root = await mkdtemp(join(tmpdir(), 'server-module-boundary-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('server-module-boundary-'))
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  const files = {
    'package.json': JSON.stringify({
      name: '@learn-electron/server',
      type: 'module',
      exports: './src/server.ts',
    }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        paths: { '#server/*': ['./src/*'] },
      },
    }),
    ...Object.fromEntries(
      ['http', 'chat', 'models', 'chatgpt', 'shared'].map((module) => [
        `src/${module}/index.ts`,
        'export {}',
      ]),
    ),
    ...sources,
  }
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, 'apps/server', name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  return checkServerModules(root)
}

test('backend modules follow the public APIs, dependency direction and acyclic graphs', () => {
  assert.deepEqual(checkServerModules(fileURLToPath(new URL('../../', import.meta.url))), [])
})

test('allowed dependencies include re-exports, types, aliases and literal dynamic imports', async (t) => {
  assert.deepEqual(
    await fixture(t, {
      'src/server.ts': "import './http/index.ts'; import './chatgpt/index.ts'",
      'src/http/index.ts': "export * from '../chat/index.ts'; import('../chatgpt/index.ts')",
      'src/chat/index.ts': "export type { ModelAccounts } from '#server/models/index.ts'",
      'src/chatgpt/index.ts': "type Accounts = import('../models/index.ts').ModelAccounts",
      'src/models/index.ts': "import '../shared/index.ts'; export interface ModelAccounts {}",
    }),
    [],
  )
})

test('backward and private imports cannot bypass module boundaries', async (t) => {
  const cases = [
    ['chat', "import '../chatgpt/index.ts'", /chat -> chatgpt/],
    ['models', "import type { Chat } from '../chat/index.ts'", /models -> chat/],
    ['models', "import('../http/index.ts')", /models -> http/],
    ['shared', "export * from '../models/index.ts'", /shared -> models/],
    ['models', "type Auth = import('../chatgpt/index.ts').Auth", /models -> chatgpt/],
    ['shared', "const http = require('../http/index.ts')", /shared -> http/],
    ['models', "import http = require('../http/index.ts')", /models -> http/],
    ['models', "import '../server.ts'", /models -> entry/],
    ['models', "import '@learn-electron/server'", /models -> entry/],
    ['http', "import '../chat/../chat/internal.ts'", /必须通过 chat\/index.ts/],
    ['http', "import '#server/chat/internal.ts'", /必须通过 chat\/index.ts/],
  ]
  for (const [module, source, expected] of cases) {
    await t.test(`${module}: ${source}`, async (t) => {
      const violations = await fixture(t, {
        [`src/${module}/probe.ts`]: source,
        'src/chat/internal.ts': 'export {}',
        'src/server.ts': 'export {}',
      })
      assert.match(violations.join('\n'), expected)
    })
  }
})

test('module cycles are rejected even when no individual files form a cycle', async (t) => {
  const violations = await fixture(t, {
    'src/chat/a.ts': "import '../models/index.ts'",
    'src/models/b.ts': "import '../chat/index.ts'",
  })
  assert.match(violations.join('\n'), /模块循环依赖/)
  assert.ok(violations.every((violation) => !violation.includes('文件循环依赖')))
})

test('file cycles include type-only imports and dynamic imports through a public barrel', async (t) => {
  await t.test('type-only cycle', async (t) => {
    const violations = await fixture(t, {
      'src/chat/a.ts': "import type { B } from './b.ts'; export interface A {}",
      'src/chat/b.ts': "import type { A } from './a.ts'; export interface B {}",
    })
    assert.match(violations.join('\n'), /文件循环依赖/)
  })
  await t.test('dynamic import and re-export cycle', async (t) => {
    const violations = await fixture(t, {
      'src/chat/index.ts': "export * from './service.ts'",
      'src/chat/service.ts': "export const load = () => import('./index.ts')",
    })
    assert.match(violations.join('\n'), /文件循环依赖/)
  })
})

test('unregistered modules, unresolved imports, computed imports and test dependencies fail closed', async (t) => {
  const cases = [
    [{ 'src/other/index.ts': 'export {}' }, /未登记的后端模块/],
    [{ 'src/helper.ts': 'export {}' }, /根目录只保留/],
    [{ 'src/chat/a.ts': "import './missing.ts'" }, /无法解析本地依赖/],
    [{ 'src/chat/a.ts': 'const name = "./service.ts"; import(name)' }, /动态依赖必须使用/],
    [
      { 'src/chat/a.ts': "import '../../test/helper.ts'", 'test/helper.ts': 'export {}' },
      /不能直接依赖源码目录外/,
    ],
  ]
  for (const [sources, expected] of cases) {
    await t.test(Object.keys(sources)[0] + ': ' + expected.source, async (t) => {
      assert.match((await fixture(t, sources)).join('\n'), expected)
    })
  }
})
