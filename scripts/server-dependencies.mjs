import { readFileSync } from 'node:fs'

// Workspace code is bundled; third-party production dependencies stay external.
const manifests = [
  '../apps/server/package.json',
  '../packages/agent-runtime/package.json',
  '../packages/chatgpt-auth/package.json',
]
export const serverDependencies = Object.fromEntries(
  manifests
    .flatMap((path) => {
      const manifest = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
      return Object.entries(manifest.dependencies)
    })
    .filter(([name]) => !name.startsWith('@learn-electron/')),
)
