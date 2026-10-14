import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

// Runtime dependencies stay external; the TypeScript-source workspace package is bundled.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith('@tradepilot/'))

await build({
  entryPoints: {
    server: 'src/main.ts',
    'create-admin': 'src/cli/create-admin.ts',
    migrate: 'src/cli/migrate.ts',
    backup: 'src/cli/backup.ts',
    'generate-keys': 'src/cli/generate-keys.ts'
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
  logLevel: 'info'
})
