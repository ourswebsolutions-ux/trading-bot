import { randomUUID } from 'node:crypto'
import type { Db } from '../db.js'
import { UserError } from '../errors.js'
import { ProviderError, requestJson } from '../net.js'

/** WhatsApp Cloud API (Meta Graph API). Business-initiated messages must use approved templates. */
export interface WhatsAppConfig {
  phoneNumberId: string
  businessAccountId?: string
  apiVersion: string
}

export const E164_DIGITS = /^[1-9]\d{7,14}$/

/** Meta error codes → actionable messages (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes). */
const WA_ERRORS: Record<number, [ProviderError['kind'], string]> = {
  190: ['auth', 'The access token is invalid or expired. Generate a permanent System User token in Meta Business Settings.'],
  10: ['permission', 'The token lacks permission. Grant whatsapp_business_messaging and whatsapp_business_management.'],
  200: ['permission', 'The token lacks permission for this phone number or business account.'],
  100: ['invalid_request', 'Invalid parameter. Check the phone number ID, business account ID and template name/language.'],
  4: ['rate_limited', 'Meta API call rate limit reached. Wait before retrying.'],
  80007: ['rate_limited', 'WhatsApp Business Account rate limit reached. Wait before retrying.'],
  130429: ['rate_limited', 'Cloud API throughput limit reached. Wait before retrying.'],
  131056: ['rate_limited', 'Too many messages to this recipient in a short time (pair rate limit). Wait before retrying.'],
  131048: ['permission', 'Spam rate limit: messages were blocked because recipients reported or ignored previous messages.'],
  131026: ['invalid_request', 'Message undeliverable: the number may not be on WhatsApp, or the recipient has not accepted the latest terms.'],
  131030: ['invalid_request', 'Recipient not in the allowed list. With a test number, add the recipient under WhatsApp → API Setup.'],
  131047: ['invalid_request', 'More than 24 hours since the recipient last replied; only approved templates can be sent.'],
  131031: ['permission', 'The business account is restricted or locked by Meta.'],
  132000: ['invalid_request', 'Template parameter count does not match the approved template.'],
  132001: ['invalid_request', 'Template does not exist in this language, or is not approved yet.'],
  133010: ['invalid_request', 'This phone number is not registered with the Cloud API.'],
  368: ['permission', 'Temporarily blocked for policy violations. Check Business Support Home.']
}

export function whatsappErrorFrom(status: number, body: unknown): ProviderError {
  const e = (body as { error?: { code?: number; message?: string; error_data?: { details?: string } } } | null)?.error
  const mapped = e?.code !== undefined ? WA_ERRORS[e.code] : undefined
  const detail = e?.error_data?.details ?? e?.message
  if (mapped) return new ProviderError(mapped[0], `${mapped[1]}${detail ? ` (Meta: ${detail})` : ''}`, status, undefined, String(e?.code))
  if (status === 429) return new ProviderError('rate_limited', 'WhatsApp rate limit reached. Wait before retrying.', status)
  return new ProviderError('provider', `WhatsApp Cloud API error${e?.code ? ` ${e.code}` : ''} (HTTP ${status})${detail ? `: ${detail}` : ''}`, status, undefined, e?.code ? String(e.code) : undefined)
}

export class WhatsAppClient {
  constructor(
    private readonly cfg: WhatsAppConfig,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep?: (ms: number) => Promise<void>
  ) {}

  private url(path: string) {
    return `https://graph.facebook.com/${this.cfg.apiVersion}/${path}`
  }

  private async get<T>(path: string): Promise<T> {
    const res = await requestJson<T>(this.url(path), { headers: { Authorization: `Bearer ${this.token}` }, fetchImpl: this.fetchImpl, sleep: this.sleep })
    if (res.status >= 400 || !res.body) throw whatsappErrorFrom(res.status, res.body)
    return res.body
  }

  phoneNumber() {
    return this.get<{ id: string; display_phone_number?: string; verified_name?: string; quality_rating?: string; code_verification_status?: string }>(
      `${encodeURIComponent(this.cfg.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`
    )
  }

  async templates(): Promise<{ name: string; status: string; language: string; category?: string }[]> {
    if (!this.cfg.businessAccountId) return []
    const body = await this.get<{ data?: { name: string; status: string; language: string; category?: string }[] }>(
      `${encodeURIComponent(this.cfg.businessAccountId)}/message_templates?fields=name,status,language,category&limit=100`
    )
    return body.data ?? []
  }

  /** Sends an approved template. Never retried automatically (a retry could deliver twice). */
  async sendTemplate(to: string, name: string, language: string, bodyParams: string[] = []): Promise<{ messageId: string; status: string | null }> {
    const res = await requestJson<{ messages?: { id: string; message_status?: string }[] }>(this.url(`${encodeURIComponent(this.cfg.phoneNumberId)}/messages`), {
      method: 'POST',
      attempts: 1,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: { name, language: { code: language }, ...(bodyParams.length ? { components: [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }] } : {}) }
      }),
      fetchImpl: this.fetchImpl
    })
    if (res.status >= 400 || !res.body) throw whatsappErrorFrom(res.status, res.body)
    const msg = res.body.messages?.[0]
    if (!msg?.id) throw new ProviderError('bad_response', 'WhatsApp did not return a message ID.')
    return { messageId: msg.id, status: msg.message_status ?? null }
  }
}

export interface Consent {
  id: string
  recipient: string
  note: string
  consentedAt: string
}

/** Opt-in register: TradePilot only sends WhatsApp messages to recipients recorded here. */
export class ConsentStore {
  constructor(private readonly db: Db) {}

  list(): Consent[] {
    return (this.db.prepare(`SELECT id, recipient, note, consented_at FROM messaging_consents WHERE channel = 'whatsapp' AND revoked_at IS NULL ORDER BY consented_at DESC`).all() as {
      id: string
      recipient: string
      note: string
      consented_at: string
    }[]).map((r) => ({ id: r.id, recipient: r.recipient, note: r.note, consentedAt: r.consented_at }))
  }

  add(recipient: string, confirmed: boolean, note: string): Consent {
    const digits = recipient.replace(/[\s()+-]/g, '')
    if (!E164_DIGITS.test(digits)) throw new UserError('validation_failed', 'Enter the number in international format, e.g. +91 98765 43210.', { recipient: 'Invalid phone number' })
    if (!confirmed) throw new UserError('validation_failed', 'Confirm that this person opted in to receive WhatsApp messages from your business.', { confirmed: 'Consent required' })
    if (this.has(digits)) throw new UserError('validation_failed', 'This number is already on the opt-in list.', { recipient: 'Already added' })
    const c: Consent = { id: randomUUID(), recipient: digits, note: note.trim().slice(0, 200), consentedAt: new Date().toISOString() }
    this.db.prepare(`INSERT INTO messaging_consents (id, channel, recipient, note, consented_at) VALUES (?, 'whatsapp', ?, ?, ?)`).run(c.id, c.recipient, c.note, c.consentedAt)
    return c
  }

  revoke(id: string): void {
    this.db.prepare(`UPDATE messaging_consents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), id)
  }

  has(recipientDigits: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM messaging_consents WHERE channel = 'whatsapp' AND recipient = ? AND revoked_at IS NULL`).get(recipientDigits))
  }
}
