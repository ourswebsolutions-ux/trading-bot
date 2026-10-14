// Prints the GitHub Release notes: docs/release-notes/<tag>.md followed by the SHA-256 checksums.
// Usage: node scripts/release-notes.mjs v1.0.0 assets/SHA256SUMS.txt
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const [tag, sums] = process.argv.slice(2)
const notesFile = path.resolve(import.meta.dirname, '..', 'docs', 'release-notes', `${tag}.md`)
if (!existsSync(notesFile)) {
  console.error(`missing release notes: ${notesFile}`)
  process.exit(1)
}
let out = readFileSync(notesFile, 'utf8').trimEnd()
if (sums && existsSync(sums)) {
  out += '\n\n## SHA-256 checksums\n\nVerify a download with `sha256sum <file>` (Linux), `shasum -a 256 <file>` (macOS) or `Get-FileHash <file>` (Windows PowerShell).\n\n```\n' + readFileSync(sums, 'utf8').trim() + '\n```\n'
}
process.stdout.write(out + '\n')
