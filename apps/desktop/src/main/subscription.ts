import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  SCREENSHOT_MAX_BYTES,
  isValidEmail,
  isValidTransactionId,
  sniffImageMime,
  type ApiErrorBody,
  type CreatedPaymentRequest,
  type PaymentRequestDto,
  type PlansResponse,
  type RegisterDeviceResponse,
  type StatusResponse
} from '@tradepilot/shared'
import { getSetting, setSetting, type Db } from './db.js'
import { evaluateEntitlement } from './entitlement.js'
import { UserError } from './errors.js'
import type { SecretStore } from './secrets.js'
import type { SmtpMessage } from '@tradepilot/shared/smtp'
import type { PlansView, ScreenshotSelection, SubmitPaymentInput, SubscriptionView } from '../shared/ipc.js'

export interface SubscriptionDeps {
  db: Db
  secrets: SecretStore
  apiBaseUrl: string
  configurationError: string | null
  publicKey: string
  appVersion: string
  platform: string
  fingerprint: () => Promise<string>
  fetch?: typeof fetch
  now?: () => Date
  onRemoteNotification?: (n: { id: string; kind: string; title: string; body: string; createdAt: string }) => void
  /** The client's own SMTP connection; payment requests are emailed through it. */
  clientEmail?: ClientEmail
}

export interface ClientEmail {
  /** Null when the connection is configured; otherwise what the client must do. */
  problem(): string | null
  /** The client's sending (registered) address. */
  address(): string | null
  send(message: SmtpMessage): Promise<void>
}

const NO_CLIENT_EMAIL: ClientEmail = {
  problem: () => 'Email is not available in this build.',
  address: () => null,
  send: async () => {
    throw new Error('Email is not available in this build.')
  }
}

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const money = (cents: number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)

const DEVICE_TOKEN = 'device.token'
const REQUEST_TIMEOUT_MS = 20_000

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>
  ) {
    super(message)
  }
}

/**
 * Client for the subscription backend. The server is authoritative; this class only
 * caches the last signed status so the app can behave sensibly while offline.
 */
export class SubscriptionService {
  private online = false
  private syncError: string | null = null
  private lastSyncedAt: string | null = null
  private screenshots = new Map<string, { path: string; bytes: Buffer; name: string; mime: string }>()
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(private readonly d: SubscriptionDeps) {
    this.fetchImpl = d.fetch ?? fetch
    this.now = d.now ?? (() => new Date())
    const cached = this.cached()
    if (cached) this.lastSyncedAt = cached.fetchedAt
  }

  get configured(): boolean {
    return !this.d.configurationError && Boolean(this.d.apiBaseUrl)
  }

  get deviceId(): string | null {
    return getSetting<string | null>(this.d.db, 'device.id', null)
  }

  private cached(): { status: StatusResponse; fetchedAt: string; localAtFetch: string } | null {
    const row = this.d.db.prepare('SELECT status_json, fetched_at FROM subscription_cache WHERE id = 1').get() as { status_json: string; fetched_at: string } | undefined
    if (!row) return null
    const parsed = JSON.parse(row.status_json) as { status: StatusResponse; localAtFetch: string }
    return { status: parsed.status, localAtFetch: parsed.localAtFetch, fetchedAt: row.fetched_at }
  }

  private async request<T>(method: string, route: string, init: { body?: BodyInit; json?: unknown; auth?: boolean } = {}): Promise<T> {
    if (!this.configured) throw new UserError('not_configured', this.d.configurationError ?? 'Subscription server is not configured.')
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': `TradePilot/${this.d.appVersion}` }
    if (init.auth !== false) {
      const token = this.d.secrets.get(DEVICE_TOKEN)
      if (!token) throw new ApiError(401, 'unauthorized', 'Device is not registered')
      headers.Authorization = `Bearer ${token}`
    }
    let body = init.body
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(init.json)
    }
    let res: Response
    try {
      res = await this.fetchImpl(`${this.d.apiBaseUrl}${route}`, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (err) {
      this.online = false
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'could not be reached'
      throw new UserError('offline', `The subscription server ${reason}. Check your internet connection and try again.`)
    }
    this.online = true
    const text = await res.text()
    const data = text ? (JSON.parse(text) as unknown) : null
    if (!res.ok) {
      const e = (data as ApiErrorBody | null)?.error
      throw new ApiError(res.status, e?.code ?? 'http_error', e?.message ?? `Server responded with HTTP ${res.status}`, e?.fields)
    }
    return data as T
  }

  /** Calls an authenticated endpoint, (re-)registering the device once if its credential is missing or revoked. */
  private async authed<T>(method: string, route: string, init: { body?: () => BodyInit; json?: unknown } = {}): Promise<T> {
    try {
      if (!this.d.secrets.get(DEVICE_TOKEN)) await this.register()
      return await this.request<T>(method, route, { body: init.body?.(), json: init.json })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await this.register()
        return this.request<T>(method, route, { body: init.body?.(), json: init.json })
      }
      throw err
    }
  }

  private async register(): Promise<void> {
    const res = await this.request<RegisterDeviceResponse>('POST', '/v1/devices/register', {
      auth: false,
      json: { fingerprint: await this.d.fingerprint(), platform: this.d.platform, appVersion: this.d.appVersion }
    })
    this.d.secrets.set(DEVICE_TOKEN, res.deviceToken, { allowUnencryptedFallback: true })
    setSetting(this.d.db, 'device.id', res.deviceId)
    setSetting(this.d.db, 'device.referenceCode', res.referenceCode)
  }

  async refresh(): Promise<SubscriptionView> {
    try {
      const status = await this.authed<StatusResponse>('GET', '/v1/status')
      const check = evaluateEntitlement(status.entitlementToken, this.d.publicKey, status.deviceId, new Date(status.serverTime))
      if (!check.payload) throw new UserError('untrusted_status', `Rejected subscription status: ${check.detail}`)
      const localAtFetch = this.now().toISOString()
      this.d.db.prepare(
        `INSERT INTO subscription_cache (id, status_json, fetched_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status_json = excluded.status_json, fetched_at = excluded.fetched_at`
      ).run(JSON.stringify({ status, localAtFetch }), localAtFetch)
      this.lastSyncedAt = localAtFetch
      this.syncError = null
      await this.pullNotifications().catch(() => undefined)
    } catch (err) {
      this.syncError = err instanceof Error ? err.message : String(err)
      if (err instanceof ApiError) this.online = true
    }
    return this.view()
  }

  private async pullNotifications(): Promise<void> {
    const res = await this.authed<{ notifications: { id: string; kind: string; title: string; body: string; createdAt: string }[] }>('GET', '/v1/notifications')
    for (const n of res.notifications) this.d.onRemoteNotification?.(n)
  }

  view(): SubscriptionView {
    const cached = this.cached()
    const decision = this.decision()
    const offset = cached ? Date.parse(cached.status.serverTime) - Date.parse(cached.localAtFetch) : 0
    let status: SubscriptionView['status'] = null
    if (cached) {
      const { entitlementToken: _omit, ...rest } = cached.status
      status = rest
    }
    return {
      configured: this.configured,
      configurationError: this.d.configurationError,
      online: this.online,
      lastSyncedAt: this.lastSyncedAt,
      syncError: this.syncError,
      status,
      serverOffsetMs: offset,
      access: {
        allowed: decision.allowed,
        reason: decision.payload?.reason ?? 'none',
        source: !decision.payload ? 'none' : this.syncError ? 'offline_token' : 'server',
        detail: !this.configured && !decision.allowed ? `${this.d.configurationError ?? 'No subscription server is configured.'} Trials and subscriptions are unavailable in this build.` : decision.detail
      }
    }
  }

  decision() {
    const cached = this.cached()
    return evaluateEntitlement(cached?.status.entitlementToken ?? null, this.d.publicKey, this.deviceId, this.now())
  }

  /** Main-process gate for paid features. Throws a user-facing error when access is not allowed. */
  requireAccess(feature: string): void {
    const d = this.decision()
    if (!d.allowed) throw new UserError('subscription_required', `${feature} requires an active trial or subscription. ${this.configured ? d.detail : 'This build has no subscription server configured, so trials and subscriptions are unavailable.'}`)
  }

  private get clientEmail(): ClientEmail {
    return this.d.clientEmail ?? NO_CLIENT_EMAIL
  }

  async plans(): Promise<PlansView> {
    return this.wrap(async () => {
      const res = await this.authed<PlansResponse>('GET', '/v1/plans')
      const problem = this.clientEmail.problem()
      return {
        ...res,
        // servers before 1.0.1 did not report availability; their submit errors still say what is wrong
        payments: res.payments ?? { available: true, businessEmail: 'ourswebsolutions@gmail.com', problem: null },
        clientEmail: { configured: problem === null, address: this.clientEmail.address(), problem }
      }
    })
  }

  async requests(): Promise<PaymentRequestDto[]> {
    return this.wrap(async () => (await this.authed<{ requests: PaymentRequestDto[] }>('GET', '/v1/payment-requests')).requests)
  }

  /** Validates a screenshot chosen via the native file dialog; the renderer only gets an opaque id and a preview. */
  async loadScreenshot(filePath: string): Promise<ScreenshotSelection> {
    const info = await stat(filePath)
    if (!info.isFile()) throw new UserError('validation_failed', 'Select an image file.')
    if (info.size > SCREENSHOT_MAX_BYTES) throw new UserError('validation_failed', 'Screenshot must be 5 MB or smaller.', { screenshot: 'Max 5 MB' })
    const bytes = await readFile(filePath)
    const mime = sniffImageMime(bytes)
    if (!mime) throw new UserError('validation_failed', 'Screenshot must be a PNG, JPEG or WebP image.', { screenshot: 'Unsupported format' })
    const id = randomUUID()
    this.screenshots.clear()
    this.screenshots.set(id, { path: filePath, bytes, name: path.basename(filePath), mime })
    return { id, name: path.basename(filePath), sizeBytes: bytes.length, mime, previewDataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
  }

  async submit(input: SubmitPaymentInput): Promise<PaymentRequestDto> {
    const fields: Record<string, string> = {}
    if (!['monthly', 'lifetime'].includes(input.planCode)) fields.planCode = 'Select a plan'
    if (!isValidTransactionId(input.transactionId ?? '')) fields.transactionId = '6–64 letters, digits or - _ . / #'
    const contactEmail = (input.contactEmail?.trim() || this.clientEmail.address() || '').trim()
    if (!isValidEmail(contactEmail)) fields.contactEmail = 'Enter your email address'
    if ((input.note ?? '').length > 500) fields.note = 'Max 500 characters'
    const shot = this.screenshots.get(input.screenshotId)
    if (!shot) fields.screenshot = 'Attach the payment screenshot'
    if (Object.keys(fields).length) throw new UserError('validation_failed', 'Please correct the highlighted fields.', fields)
    // the request is emailed through the client's own SMTP connection, so it must be set up first
    const emailProblem = this.clientEmail.problem()
    if (emailProblem) throw new UserError('email_not_configured', emailProblem)

    const created = await this.wrap(() =>
      this.authed<CreatedPaymentRequest>('POST', '/v1/payment-requests', {
        body: () => {
          const form = new FormData()
          form.set('planCode', input.planCode)
          form.set('transactionId', input.transactionId.trim())
          form.set('contactEmail', contactEmail)
          if (input.note?.trim()) form.set('note', input.note.trim())
          form.set('screenshot', new Blob([new Uint8Array(shot!.bytes)], { type: shot!.mime }), shot!.name)
          return form
        }
      })
    )
    const r = created.request
    const planName = input.planCode === 'lifetime' ? 'Lifetime' : 'Monthly'
    try {
      await this.clientEmail.send({
        to: created.businessEmail,
        subject: `[TradePilot] ${planName} payment request — ${money(r.amountCents, r.currency)} — ${created.referenceCode}`,
        text: [
          'A TradePilot client submitted a payment and asks you to confirm it.',
          '',
          `Client email:     ${contactEmail}`,
          `Client reference: ${created.referenceCode}`,
          `Plan:             ${planName}`,
          `Amount:           ${money(r.amountCents, r.currency)}`,
          `Transaction ID:   ${r.transactionId}`,
          `Request ID:       ${r.id}`,
          `Submitted:        ${r.createdAt}`,
          ...(input.note?.trim() ? [`Client note:      ${input.note.trim()}`] : []),
          '',
          'The payment screenshot is attached. Verify that the funds arrived, then use one of these links:',
          '',
          `  Confirm Payment:  ${created.review.confirmUrl}`,
          `  Cancel Request:   ${created.review.cancelUrl}`,
          '',
          'Opening a link changes nothing. The page shows the request and asks for your review passphrase',
          'before anything is applied. The links work once and expire on ' + created.review.expiresAt.slice(0, 16).replace('T', ' ') + ' UTC.',
          '',
          'This email was sent from the client\'s own email account by the TradePilot app.'
        ].join('\n'),
        attachments: [{ filename: `payment-${r.transactionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}.${EXTENSIONS[shot!.mime] ?? 'img'}`, content: shot!.bytes, contentType: shot!.mime }]
      })
    } catch (err) {
      // never leave a request pending that the business was not told about
      const why = err instanceof Error ? err.message : String(err)
      await this.authed('DELETE', `/v1/payment-requests/${encodeURIComponent(r.id)}`, { json: { reason: `email failed: ${why.slice(0, 200)}` } }).catch(() => undefined)
      await this.refresh().catch(() => undefined)
      throw new UserError('payment_email_failed', `Your payment request could not be emailed to ${created.businessEmail}: ${why}. Nothing was submitted. Check Settings → SMTP Email (Send test email) and try again.`)
    }
    this.screenshots.delete(input.screenshotId)
    await this.refresh()
    return r
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof ApiError) throw new UserError(err.code, err.message, err.fields)
      throw err
    }
  }
}
