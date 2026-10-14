/**
 * Generates the Ed25519 entitlement signing key pair.
 *   npm run keys:generate -- --out /secure/path
 * Keep the private key on the server only; pin the printed public key in the desktop build.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { generateSigningKeyPair } from '../security/keys.js'

const { values } = parseArgs({ options: { out: { type: 'string', default: './data/keys' } } })
const dir = path.resolve(values.out!)
const privateFile = path.join(dir, 'entitlement-private.pem')
if (existsSync(privateFile)) {
  console.error(`${privateFile} already exists; refusing to overwrite (rotating it invalidates issued tokens).`)
  process.exit(1)
}
mkdirSync(dir, { recursive: true, mode: 0o700 })
const pair = generateSigningKeyPair()
writeFileSync(privateFile, pair.privatePem, { mode: 0o600 })
writeFileSync(path.join(dir, 'entitlement-public.pem'), pair.publicPem)
console.log(`Private key: ${privateFile}  (set ENTITLEMENT_PRIVATE_KEY_FILE to this path)`)
console.log(`Public key (MAIN_VITE_ENTITLEMENT_PUBLIC_KEY): ${pair.publicKeyBase64}`)
