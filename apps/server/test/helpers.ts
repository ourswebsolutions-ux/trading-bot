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
import { createAdmin, type AdminRole } from '../src/services/admins.js'
import { MemoryMailer } from '../src/services/mailer.js'
import { setSetting } from '../src/services/settings.js'
import { createPrivateKey, createPublicKey } from 'node:crypto'

export const T0 = new Date('2026-01-10T12:00:00.000Z')
export const ADMIN_EMAIL = 'owner@example.test'
export const ADMIN_PASSWORD = 'correct horse battery staple'

export interface Harness {
  app: FastifyInstance
  ctx: AppContext
  clock: ManualClock
  mailer: MemoryMailer
  close: () => Promise<void>
}

export async function createHarness(opts: { configurePayments?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-server-test-'))
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, PUBLIC_BASE_URL: 'https://admin.example.test', ADMIN_NOTIFY_EMAIL: 'payments@example.test' })
  const clock = new ManualClock(T0)
  const mailer = new MemoryMailer()
  const pair = generateSigningKeyPair()
  const privateKey = createPrivateKey(pair.privatePem)
  const ctx = createContext(config, {
    clock,
    mailer,
    keys: { privateKey, publicKey: createPublicKey(privateKey), publicKeyBase64: pair.publicKeyBase64 }
  })
  if (opts.configurePayments !== false) {
    setSetting(ctx.db, 'payment_instructions', 'Send USDT (TRC20) to wallet TXYZ… and put your reference code in the memo.', T0, null)
  }
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
  const body = multipart({ planCode: 'monthly', transactionId: `TXN-${randomBytes(4).toString('hex')}`, ...fields } as Record<string, string>, file ?? undefined)
  return h.app.inject({ method: 'POST', url: '/v1/payment-requests', payload: body.payload, headers: { ...body.headers, authorization: `Bearer ${token}` } })
}

export async function createAdminAccount(h: Harness, role: AdminRole = 'superadmin', email = ADMIN_EMAIL): Promise<string> {
  return createAdmin(h.ctx.db, h.clock.now(), { email, displayName: 'Owner', password: ADMIN_PASSWORD, role })
}

/** Performs the real login flow (GET form → CSRF cookie → POST) and returns cookie header + session CSRF token. */
let ipCounter = 0
/** Each simulated sign-in comes from its own address unless one is given, so the per-IP login limit does not leak between tests. */
export async function adminLogin(h: Harness, email = ADMIN_EMAIL, password = ADMIN_PASSWORD, remoteAddress = `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`) {
  const form = await h.app.inject({ method: 'GET', url: '/admin/login', remoteAddress })
  const loginCookie = form.cookies.find((c) => c.name === 'tp_login' || c.name === '__Host-tp_login')!
  const csrf = /name="_csrf" value="([^"]+)"/.exec(form.body)![1]!
  const res = await h.app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { cookie: `${loginCookie.name}=${loginCookie.value}` },
    payload: { _csrf: csrf, email, password, next: '/admin' },
    remoteAddress
  })
  const session = res.cookies.find((c) => c.name.endsWith('tp_admin'))
  if (!session) return { res, cookie: '', csrf: '' }
  const cookie = `${session.name}=${session.value}`
  const page = await h.app.inject({ method: 'GET', url: '/admin', headers: { cookie } })
  const sessionCsrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!
  return { res, cookie, csrf: sessionCsrf }
}
