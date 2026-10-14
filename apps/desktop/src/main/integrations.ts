import { createHmac } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import nodemailer from 'nodemailer'
import { isValidEmail } from '@tradepilot/shared'
import type { Db } from './db.js'
import { UserError } from './errors.js'
import type { SecretStore } from './secrets.js'
import type { IntegrationId, IntegrationSaveInput, IntegrationView } from '../shared/ipc.js'

interface FieldSpec {
  key: string
  required: boolean
  validate?: (v: string) => string | null
  default?: string
}
interface IntegrationSpec {
  config: FieldSpec[]
  secrets: FieldSpec[]
  test: (config: Record<string, string>, secrets: Record<string, string>) => Promise<string>
}

export const DELTA_BASE_URLS = ['https://api.india.delta.exchange', 'https://api.delta.exchange', 'https://cdn-ind.testnet.deltaex.org', 'https://testnet-api.delta.exchange']
const TIMEOUT = 15_000

const httpsUrl = (v: string) => (/^https:\/\/[\w.-]+(:\d+)?$/.test(v) ? null : 'Must be an https:// origin')
const port = (v: string) => (/^\d+$/.test(v) && +v > 0 && +v < 65536 ? null : 'Enter a port between 1 and 65535')
const email = (v: string) => (isValidEmail(v) ? null : 'Enter a valid email address')
const bool = (v: string) => (v === 'true' || v === 'false' ? null : 'Must be true or false')

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

async function guardedFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) })
  } catch (err) {
    const why = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'failed (network unreachable or DNS error)'
    throw new Error(`Connection ${why}.`)
  }
}

/** Delta Exchange REST signature: hex HMAC-SHA256(secret, method + timestamp + path + query + body). */
export function deltaSignature(secret: string, method: string, timestamp: string, path: string, query = '', body = ''): string {
  return createHmac('sha256', secret).update(method + timestamp + path + query + body).digest('hex')
}

export const INTEGRATIONS: Record<IntegrationId, IntegrationSpec> = {
  delta: {
    config: [{ key: 'baseUrl', required: true, default: DELTA_BASE_URLS[0], validate: (v) => (DELTA_BASE_URLS.includes(v) ? null : 'Choose a Delta Exchange API endpoint') }],
    secrets: [{ key: 'apiKey', required: true }, { key: 'apiSecret', required: true }],
    async test(config, secrets) {
      const path = '/v2/wallet/balances'
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const res = await guardedFetch(config.baseUrl + path, {
        headers: {
          'api-key': secrets.apiKey!,
          timestamp,
          signature: deltaSignature(secrets.apiSecret!, 'GET', timestamp, path),
          'User-Agent': 'TradePilot',
          Accept: 'application/json'
        }
      })
      const body = await readJson(res)
      if (res.ok && body?.success) {
        const n = Array.isArray(body.result) ? body.result.length : 0
        return `Authenticated with Delta Exchange (read access to ${n} wallet balance${n === 1 ? '' : 's'}). Live trading stays disabled in this release.`
      }
      const code = (body?.error as { code?: string } | undefined)?.code
      const hints: Record<string, string> = {
        invalid_api_key: 'The API key was not recognised for this endpoint (India and Global accounts use different endpoints).',
        Signature_Mismatch: 'The API secret does not match the key.',
        expired_signature: 'Request signature expired: check that your computer clock is correct.',
        ip_not_whitelisted_for_api_key: 'This IP address is not whitelisted for the API key.',
        UnauthorizedApiAccess: 'The key lacks permission for wallet data.'
      }
      throw new Error(hints[code ?? ''] ?? `Delta Exchange rejected the credentials (${code ?? `HTTP ${res.status}`}).`)
    }
  },
  openai: {
    config: [],
    secrets: [{ key: 'apiKey', required: true }],
    async test(_c, secrets) {
      const res = await guardedFetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${secrets.apiKey}` } })
      if (res.ok) {
        const body = await readJson(res)
        const n = Array.isArray(body?.data) ? body.data.length : 0
        return `Authenticated with OpenAI (${n} models available).`
      }
      if (res.status === 401) throw new Error('OpenAI rejected the API key (401).')
      if (res.status === 429) throw new Error('OpenAI rate limit or quota exceeded (429).')
      throw new Error(`OpenAI responded with HTTP ${res.status}.`)
    }
  },
  anthropic: {
    config: [],
    secrets: [{ key: 'apiKey', required: true }],
    async test(_c, secrets) {
      const client = new Anthropic({ apiKey: secrets.apiKey!, timeout: TIMEOUT, maxRetries: 0 })
      try {
        const page = await client.models.list({ limit: 1 })
        return `Authenticated with Anthropic (models endpoint reachable${page.data[0] ? `, e.g. ${page.data[0].id}` : ''}).`
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key (401).')
        if (err instanceof Anthropic.PermissionDeniedError) throw new Error('The API key does not have permission to list models (403).')
        if (err instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit reached (429). Try again shortly.')
        if (err instanceof Anthropic.APIConnectionError) throw new Error('Could not reach api.anthropic.com.')
        if (err instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${err.status ?? ''}: ${err.message}`)
        throw err
      }
    }
  },
  smtp: {
    config: [
      { key: 'host', required: true },
      { key: 'port', required: true, default: '587', validate: port },
      { key: 'secure', required: true, default: 'false', validate: bool },
      { key: 'username', required: false },
      { key: 'from', required: true, validate: email },
      { key: 'testRecipient', required: true, validate: email }
    ],
    secrets: [{ key: 'password', required: false }],
    async test(config, secrets) {
      const transport = nodemailer.createTransport({
        host: config.host,
        port: Number(config.port),
        secure: config.secure === 'true',
        requireTLS: config.secure !== 'true',
        auth: config.username ? { user: config.username, pass: secrets.password ?? '' } : undefined,
        tls: { minVersion: 'TLSv1.2' },
        connectionTimeout: TIMEOUT,
        greetingTimeout: TIMEOUT,
        socketTimeout: TIMEOUT
      })
      try {
        await transport.verify()
        const info = await transport.sendMail({
          from: config.from,
          to: config.testRecipient,
          subject: 'TradePilot — SMTP test',
          text: 'This test message confirms TradePilot can deliver alert emails through your SMTP server.'
        })
        if (info.rejected?.length) throw new Error(`Recipient rejected: ${info.rejected.join(', ')}`)
        return `Test email accepted by ${config.host} for ${config.testRecipient}.`
      } finally {
        transport.close()
      }
    }
  },
  whatsapp: {
    config: [
      { key: 'phoneNumberId', required: true, validate: (v) => (/^\d{5,25}$/.test(v) ? null : 'Phone number ID is numeric') },
      { key: 'apiVersion', required: true, default: 'v21.0', validate: (v) => (/^v\d+\.\d+$/.test(v) ? null : 'Format like v21.0') }
    ],
    secrets: [{ key: 'accessToken', required: true }],
    async test(config, secrets) {
      const url = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}?fields=display_phone_number,verified_name`
      const res = await guardedFetch(url, { headers: { Authorization: `Bearer ${secrets.accessToken}` } })
      const body = await readJson(res)
      if (res.ok && body) return `Credentials valid for ${body.verified_name ?? 'business'} (${body.display_phone_number ?? config.phoneNumberId}).`
      const msg = (body?.error as { message?: string } | undefined)?.message
      throw new Error(msg ? `WhatsApp Cloud API: ${msg}` : `WhatsApp Cloud API responded with HTTP ${res.status}.`)
    }
  }
}

const secretName = (id: IntegrationId, key: string) => `${id}.${key}`
const configKey = (id: IntegrationId) => `integration.${id}`

export class IntegrationService {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore
  ) {}

  config(id: IntegrationId): Record<string, string> {
    const stored = (this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(configKey(id)) as { value: string } | undefined)?.value
    const values = stored ? (JSON.parse(stored) as Record<string, string>) : {}
    for (const f of INTEGRATIONS[id].config) if (values[f.key] === undefined && f.default !== undefined) values[f.key] = f.default
    return values
  }

  private isConfigured(id: IntegrationId): boolean {
    const spec = INTEGRATIONS[id]
    const cfg = this.config(id)
    return spec.config.every((f) => !f.required || cfg[f.key]) && spec.secrets.every((f) => !f.required || this.secrets.hint(secretName(id, f.key)))
  }

  view(id: IntegrationId): IntegrationView {
    const status = this.db.prepare('SELECT state, message, checked_at FROM integration_status WHERE integration = ?').get(id) as
      | { state: 'untested' | 'connected' | 'failed'; message: string | null; checked_at: string | null }
      | undefined
    const configured = this.isConfigured(id)
    return {
      id,
      state: !configured ? 'not_configured' : (status?.state ?? 'untested'),
      message: configured ? (status?.message ?? null) : null,
      checkedAt: configured ? (status?.checked_at ?? null) : null,
      config: this.config(id),
      secrets: Object.fromEntries(INTEGRATIONS[id].secrets.map((f) => [f.key, this.secrets.hint(secretName(id, f.key))]))
    }
  }

  list(): IntegrationView[] {
    return (Object.keys(INTEGRATIONS) as IntegrationId[]).map((id) => this.view(id))
  }

  save(input: IntegrationSaveInput): IntegrationView {
    const spec = INTEGRATIONS[input.id]
    if (!spec) throw new UserError('validation_failed', 'Unknown integration')
    const fields: Record<string, string> = {}
    const config: Record<string, string> = {}
    for (const f of spec.config) {
      const v = (input.config[f.key] ?? '').trim()
      if (!v && f.required) fields[f.key] = 'Required'
      else if (v && f.validate) {
        const problem = f.validate(v)
        if (problem) fields[f.key] = problem
      }
      config[f.key] = v
    }
    for (const f of spec.secrets) {
      const v = input.secrets[f.key]
      if (v === undefined) continue
      if (v.trim() === '' && f.required) fields[f.key] = 'Required'
      if (/\s/.test(v.trim()) && v.trim().length > 0 && f.key !== 'password') fields[f.key] = 'Must not contain spaces'
    }
    for (const f of spec.secrets) {
      if (f.required && input.secrets[f.key] === undefined && !this.secrets.hint(secretName(input.id, f.key))) fields[f.key] = 'Required'
    }
    if (Object.keys(fields).length) throw new UserError('validation_failed', 'Please correct the highlighted fields.', fields)

    for (const f of spec.secrets) {
      const v = input.secrets[f.key]
      if (v === undefined) continue
      if (v.trim() === '') this.secrets.delete(secretName(input.id, f.key))
      else this.secrets.set(secretName(input.id, f.key), f.key === 'password' ? v : v.trim())
    }
    this.db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(configKey(input.id), JSON.stringify(config), new Date().toISOString())
    // Any change invalidates the previous test result.
    this.db.prepare(`INSERT INTO integration_status (integration, state, message, checked_at) VALUES (?, 'untested', NULL, NULL)
      ON CONFLICT(integration) DO UPDATE SET state = 'untested', message = NULL, checked_at = NULL`).run(input.id)
    return this.view(input.id)
  }

  clear(id: IntegrationId): IntegrationView {
    for (const f of INTEGRATIONS[id].secrets) this.secrets.delete(secretName(id, f.key))
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(configKey(id))
    this.db.prepare('DELETE FROM integration_status WHERE integration = ?').run(id)
    return this.view(id)
  }

  /** Runs a real connection test and stores its actual outcome. */
  async test(id: IntegrationId): Promise<IntegrationView> {
    if (!this.isConfigured(id)) throw new UserError('not_configured', 'Save the required settings before testing the connection.')
    const spec = INTEGRATIONS[id]
    const secrets: Record<string, string> = {}
    for (const f of spec.secrets) {
      const v = this.secrets.get(secretName(id, f.key))
      if (v !== null) secrets[f.key] = v
    }
    let state: 'connected' | 'failed'
    let message: string
    try {
      message = await spec.test(this.config(id), secrets)
      state = 'connected'
    } catch (err) {
      state = 'failed'
      message = (err instanceof Error ? err.message : String(err)).slice(0, 400)
      // never echo credentials back if a library included them in an error
      for (const v of Object.values(secrets)) if (v.length >= 6) message = message.split(v).join('••••')
    }
    this.db.prepare(`INSERT INTO integration_status (integration, state, message, checked_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(integration) DO UPDATE SET state = excluded.state, message = excluded.message, checked_at = excluded.checked_at`)
      .run(id, state, message, new Date().toISOString())
    return this.view(id)
  }

  /** Credentials for other main-process modules (never sent to the renderer). */
  secret(id: IntegrationId, key: string): string | null {
    return this.secrets.get(secretName(id, key))
  }
}
