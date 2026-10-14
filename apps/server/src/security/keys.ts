import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ServerConfig } from '../config.js'

export interface SigningKeys {
  privateKey: KeyObject
  publicKey: KeyObject
  /** base64 SPKI DER — the value the desktop build pins as its entitlement public key. */
  publicKeyBase64: string
}

export function generateSigningKeyPair(): { privatePem: string; publicPem: string; publicKeyBase64: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  }
}

function fromPrivatePem(pem: string): SigningKeys {
  const privateKey = createPrivateKey(pem)
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Entitlement signing key must be Ed25519')
  const publicKey = createPublicKey(privateKey)
  return { privateKey, publicKey, publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
}

/**
 * Production: the key must be provisioned via ENTITLEMENT_PRIVATE_KEY_FILE (config enforces it).
 * Development: a key is generated once under DATA_DIR/keys so restarts keep issued tokens valid.
 */
export function loadSigningKeys(config: ServerConfig): SigningKeys {
  if (config.entitlementPrivateKeyFile) return fromPrivatePem(readFileSync(config.entitlementPrivateKeyFile, 'utf8'))
  const file = path.join(config.dataDir, 'keys', 'entitlement-private.pem')
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const pair = generateSigningKeyPair()
    writeFileSync(file, pair.privatePem, { mode: 0o600 })
    writeFileSync(path.join(path.dirname(file), 'entitlement-public.pem'), pair.publicPem)
  }
  return fromPrivatePem(readFileSync(file, 'utf8'))
}
