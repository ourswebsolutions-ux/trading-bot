#!/usr/bin/env node
/**
 * One-time local development setup:
 *  - generates the server's Ed25519 entitlement key pair (apps/server/data/keys)
 *  - writes apps/server/.env and apps/desktop/.env pointing at http://127.0.0.1:8787
 * Never overwrites existing files. Development only — production keys are provisioned separately.
 */
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const keyDir = path.join(root, 'apps/server/data/keys')
const privateFile = path.join(keyDir, 'entitlement-private.pem')
const publicFile = path.join(keyDir, 'entitlement-public.pem')

mkdirSync(keyDir, { recursive: true, mode: 0o700 })
if (!existsSync(privateFile)) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  writeFileSync(privateFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  writeFileSync(publicFile, publicKey.export({ type: 'spki', format: 'pem' }))
  console.log(`created ${path.relative(root, privateFile)}`)
}
const der = readFileSync(publicFile, 'utf8').replace(/-----[^-]+-----|\s/g, '')

const serverEnv = path.join(root, 'apps/server/.env')
if (!existsSync(serverEnv)) {
  writeFileSync(serverEnv, `NODE_ENV=development\nPUBLIC_BASE_URL=http://127.0.0.1:8787\nDATA_DIR=./data\nENTITLEMENT_PRIVATE_KEY_FILE=./data/keys/entitlement-private.pem\n`)
  console.log('created apps/server/.env')
}
const desktopEnv = path.join(root, 'apps/desktop/.env')
if (!existsSync(desktopEnv)) {
  writeFileSync(desktopEnv, `MAIN_VITE_API_BASE_URL=http://127.0.0.1:8787\nMAIN_VITE_ENTITLEMENT_PUBLIC_KEY=${der}\n`)
  console.log('created apps/desktop/.env')
}
console.log('\nNext:\n  npm run review:passphrase -w @tradepilot/server -- --write   (the passphrase used to confirm payments)\n  npm run dev\nClients email payment requests to ADMIN_NOTIFY_EMAIL (default ourswebsolutions@gmail.com) through their own SMTP connection (Settings → SMTP Email); you confirm them from the links in that email with the passphrase.')
