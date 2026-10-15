/**
 * Creates the hash for REVIEW_PASSPHRASE_HASH. The passphrase itself is never stored or printed.
 *   npm run review:passphrase -w @tradepilot/server              print the line to add
 *   npm run review:passphrase -w @tradepilot/server -- --write   write it into apps/server/.env
 *   ... -- --write /etc/tradepilot/review-passphrase.hash        write only the hash to a file (REVIEW_PASSPHRASE_HASH_FILE)
 * Reads it twice from a hidden prompt (or once from stdin when piped, for automation).
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { hashPassword } from '@tradepilot/shared/passwords'

const MIN_LENGTH = 12

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = ''
    for await (const chunk of process.stdin) data += chunk
    return data.split(/\r?\n/)[0] ?? ''
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })
    write._writeToOutput = (s: string) => {
      if (s.includes(prompt)) process.stdout.write(prompt)
    }
    rl.question(prompt, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

const first = await readHidden('Review passphrase: ')
if (first.length < MIN_LENGTH) {
  console.error(`The passphrase must be at least ${MIN_LENGTH} characters.`)
  process.exit(1)
}
if (process.stdin.isTTY && (await readHidden('Repeat passphrase: ')) !== first) {
  console.error('The passphrases do not match.')
  process.exit(1)
}
const hash = await hashPassword(first)
const writeAt = process.argv.indexOf('--write')
if (writeAt >= 0) {
  const target = process.argv[writeAt + 1]
  if (target && !target.endsWith('.env')) {
    // a dedicated hash file for REVIEW_PASSPHRASE_HASH_FILE (recommended in production)
    writeFileSync(target, hash + '\n', { mode: 0o600 })
    chmodSync(target, 0o600)
    console.log(`\nWrote the hash to ${target} (mode 600). Set REVIEW_PASSPHRASE_HASH_FILE=${target} and restart the server.`)
  } else {
    const envFile = path.resolve(target ?? path.join(import.meta.dirname, '../../.env'))
    const line = `REVIEW_PASSPHRASE_HASH='${hash}'`
    const current = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
    const next = /^REVIEW_PASSPHRASE_HASH=.*$/m.test(current) ? current.replace(/^REVIEW_PASSPHRASE_HASH=.*$/m, line) : `${current.replace(/\n*$/, '\n')}${line}\n`
    writeFileSync(envFile, next.replace(/^\n/, ''), { mode: 0o600 })
    console.log(`\nSaved REVIEW_PASSPHRASE_HASH in ${envFile}. Restart the server (stop npm run dev with Ctrl+C and start it again).`)
  }
} else {
  console.log('\nAdd this line to the server environment (apps/server/.env or your secret store), then restart the server:\n')
  console.log(`REVIEW_PASSPHRASE_HASH='${hash}'\n`)
  console.log('Or run this command again with --write to save it to apps/server/.env.')
}
console.log('Enter the passphrase itself on the Confirm Payment / Cancel Request page. Keep it private; never put it in the repository.')
