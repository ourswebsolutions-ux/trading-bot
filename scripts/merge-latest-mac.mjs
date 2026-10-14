// electron-builder writes one latest-mac.yml per macOS architecture build. electron-updater
// expects a single latest-mac.yml listing every architecture's files; merge them.
// Usage: node scripts/merge-latest-mac.mjs <dir containing latest-mac-*.yml>
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const dir = process.argv[2] ?? '.'
const parts = readdirSync(dir).filter((f) => /^latest-mac-.+\.yml$/.test(f)).sort()
if (parts.length === 0) {
  console.log('no macOS update metadata to merge')
  process.exit(0)
}
/** Splits an electron-builder update file into its header lines, file entries and trailer lines. */
function parse(text) {
  const lines = text.replace(/\r\n/g, '\n').trimEnd().split('\n')
  const start = lines.indexOf('files:')
  if (start < 0) throw new Error('unexpected latest-mac.yml format (no files:)')
  let end = start + 1
  while (end < lines.length && lines[end].startsWith('  ')) end++
  return { head: lines.slice(0, start), files: lines.slice(start + 1, end), tail: lines.slice(end) }
}
const parsed = parts.map((f) => parse(readFileSync(path.join(dir, f), 'utf8')))
const versions = new Set(parsed.map((p) => p.head.find((l) => l.startsWith('version:'))))
if (versions.size !== 1) throw new Error(`macOS builds disagree on the version: ${[...versions].join(', ')}`)
const first = parsed[0]
const merged = [...first.head, 'files:', ...parsed.flatMap((p) => p.files), ...first.tail].join('\n') + '\n'
writeFileSync(path.join(dir, 'latest-mac.yml'), merged)
for (const f of parts) rmSync(path.join(dir, f))
console.log(`merged ${parts.join(', ')} into latest-mac.yml`)
