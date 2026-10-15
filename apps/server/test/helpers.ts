import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { RegisterDeviceResponse } from '@tradepilot/shared'
import { createContext } from '../src/bootstrap.js'
import { ManualClock } from '../src/clock.js'
import { loadConfig } from '../src/config.js'
import type { AppContext } from '../src/context.js'
import { buildApp } from '../src/http/app.js'
import { generateSigningKeyPair } from '../src/security/keys.js'
import { MemoryMailer } from '../src/services/mailer.js'
import { setSetting } from '../src/services/settings.js'
import { createPrivateKey, createPublicKey } from 'node:crypto'

export const T0 = new Date('2026-01-10T12:00:00.000Z')
/** The business address that receives payment requests (the server default). */
export const BUSINESS_EMAIL = 'ourswebsolutions@gmail.com'
export const REVIEW_PASSPHRASE = 'correct horse battery staple'
let passphraseHash: Promise<string> | null = null
const hashOnce = () => (passphraseHash ??= import('@tradepilot/shared/passwords').then((m) => m.hashPassword(REVIEW_PASSPHRASE)))
/** Review links returned to the app when each request was created (the app emails them). */
const issuedLinks = new Map<string, { confirm: string; cancel: string }>()

export interface Harness {
  app: FastifyInstance
  ctx: AppContext
  clock: ManualClock
  mailer: MemoryMailer
  close: () => Promise<void>
}

export async function createHarness(opts: { paymentDetails?: string; passphrase?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-server-test-'))
  const config = loadConfig({
    NODE_ENV: 'test', DATA_DIR: dir, PUBLIC_BASE_URL: 'https://admin.example.test',
    ...(opts.passphrase === false ? {} : { REVIEW_PASSPHRASE_HASH: await hashOnce() })
  })
  const clock = new ManualClock(T0)
  const mailer = new MemoryMailer()
  const pair = generateSigningKeyPair()
  const privateKey = createPrivateKey(pair.privatePem)
  const ctx = createContext(config, {
    clock,
    mailer,
    keys: { privateKey, publicKey: createPublicKey(privateKey), publicKeyBase64: pair.publicKeyBase64 }
  })
  if (opts.paymentDetails) setSetting(ctx.db, 'payment_instructions', opts.paymentDetails, T0, null)
  const app = await buildApp(ctx)
  return {
    app,
    ctx,
    clock,
    mailer,
    close: async () => {
      await app.close()
      await ctx.notifier.idle()
      ctx.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export const fingerprint = (seed = randomBytes(8).toString('hex')) => createHash('sha256').update(seed).digest('hex')

export async function registerDevice(h: Harness, fp = fingerprint()): Promise<RegisterDeviceResponse & { fingerprint: string }> {
  const res = await h.app.inject({ method: 'POST', url: '/v1/devices/register', payload: { fingerprint: fp, platform: 'linux', appVersion: '0.1.0' } })
  if (res.statusCode !== 200) throw new Error(`register failed: ${res.statusCode} ${res.body}`)
  return { ...(res.json() as RegisterDeviceResponse), fingerprint: fp }
}

/** Smallest valid PNG (1×1 transparent pixel). */
export const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a8f30000000049454e44ae426082',
  'hex'
)

export function multipart(fields: Record<string, string>, file?: { name?: string; filename: string; contentType: string; data: Buffer }) {
  const boundary = `----tp${randomBytes(8).toString('hex')}`
  const chunks: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  if (file) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name ?? 'screenshot'}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`))
    chunks.push(file.data, Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

export async function submitPayment(
  h: Harness,
  token: string,
  fields: Partial<Record<'planCode' | 'transactionId' | 'contactEmail' | 'note' | 'amountCents', string>> = {},
  file: { filename: string; contentType: string; data: Buffer } | null = { filename: 'proof.png', contentType: 'image/png', data: PNG_1PX }
) {
  const body = multipart({ planCode: 'monthly', transactionId: `TXN-${randomBytes(4).toString('hex')}`, contactEmail: 'client@example.test', ...fields } as Record<string, string>, file ?? undefined)
  const res = await h.app.inject({ method: 'POST', url: '/v1/payment-requests', payload: body.payload, headers: { ...body.headers, authorization: `Bearer ${token}` } })
  if (res.statusCode === 201) {
    const created = res.json() as { request: { id: string }; review: { confirmUrl: string; cancelUrl: string } }
    issuedLinks.set(created.request.id, { confirm: new URL(created.review.confirmUrl).pathname, cancel: new URL(created.review.cancelUrl).pathname })
  }
  return res
}

let ipCounter = 0
const nextIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`

/** Confirm/Cancel paths issued to the app for a request (the app emails them to the business). */
export async function emailedLinks(_h: Harness, requestId: string): Promise<{ confirm: string; cancel: string }> {
  const links = issuedLinks.get(requestId)
  if (!links) throw new Error('no review links issued for request')
  return links
}

/** Opens a review link like a browser: GET the page, keep the CSRF cookie, POST the form. */
export async function submitReview(
  h: Harness,
  path: string,
  fields: Record<string, string>,
  opts: { remoteAddress?: string; origin?: string; skipCsrf?: boolean; passphrase?: string } = {}
) {
  const remoteAddress = opts.remoteAddress ?? nextIp()
  const page = await h.app.inject({ method: 'GET', url: path, remoteAddress })
  if (page.statusCode !== 200) return { page, res: page }
  const cookie = page.cookies.find((c) => c.name.endsWith('tp_review'))!
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!
  const res = await h.app.inject({
    method: 'POST',
    url: path,
    remoteAddress,
    headers: { cookie: `${cookie.name}=${cookie.value}`, ...(opts.origin ? { origin: opts.origin } : {}) },
    payload: { ...(opts.skipCsrf ? {} : { _csrf: csrf }), passphrase: opts.passphrase ?? REVIEW_PASSPHRASE, ...fields }
  })
  return { page, res }
}
