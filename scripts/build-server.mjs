import { build } from 'esbuild'
import { serverDependencies } from './server-dependencies.mjs'

await build({
  entryPoints: {
    index: 'apps/server/src/cli.ts',
    'desktop-child': 'apps/server/src/desktop-child.ts',
    server: 'apps/server/src/server.ts',
  },
  outdir: 'out/server',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  external: Object.keys(serverDependencies),
})
