import type { Db } from './db.js'
import { UserError } from './errors.js'
import { ProviderError } from './net.js'
import { redact, registerSecret } from './redact.js'
import type { SecretStore } from './secrets.js'
import type { IntegrationActionResult, IntegrationId, IntegrationSaveInput, IntegrationView } from '../shared/ipc.js'

export interface FieldSpec {
  key: string
  required: boolean
  default?: string
  validate?: (v: string) => string | null
}

export interface ActionContext {
  config: Record<string, string>
  secret: (key: string) => string | null
  progress: (step: string) => void
}

export interface IntegrationSpec {
  config: FieldSpec[]
  secrets: FieldSpec[]
  /** Real provider call proving the configuration works. Returns a human-readable result. */
  test: (ctx: ActionContext) => Promise<string>
  /** Extra provider actions (send test email, refresh models…). */
  actions?: Record<string, (ctx: ActionContext, params: Record<string, unknown>) => Promise<string>>
  /** Section data shown in Settings; must never include secrets. */
  extras?: (ctx: Omit<ActionContext, 'progress'>, details: Record<string, unknown>) => Record<string, unknown>
}

// ---------- reusable validators ----------
export const v8n = {
  port: (v: string) => (/^\d+$/.test(v) && +v > 0 && +v < 65536 ? null : 'Enter a port between 1 and 65535'),
  bool: (v: string) => (v === 'true' || v === 'false' ? null : 'Must be true or false'),
  intRange: (lo: number, hi: number) => (v: string) => (/^\d+$/.test(v) && +v >= lo && +v <= hi ? null : `Whole number between ${lo} and ${hi}`),
  oneOf: (values: string[], msg: string) => (v: string) => (values.includes(v) ? null : msg)
}

const secretName = (id: IntegrationId, key: string) => `${id}.${key}`
const configKey = (id: IntegrationId) => `integration.${id}`

interface StatusRow {
  state: 'untested' | 'connected' | 'failed'
  message: string | null
  checked_at: string | null
  last_success_at: string | null
  details: string | null
}

/** Message safe for the UI and logs: classified errors keep their text, everything is redacted. */
export function describeError(err: unknown): string {
  const msg = err instanceof ProviderError || err instanceof UserError || err instanceof Error ? err.message : String(err)
  return redact(msg).slice(0, 500)
}

export class IntegrationService {
  private details = new Map<IntegrationId, Record<string, unknown>>()

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly specs: Record<IntegrationId, IntegrationSpec>,
    private readonly onProgress: (id: IntegrationId, step: string) => void = () => {},
    private readonly migrateConfig: (id: IntegrationId, values: Record<string, string>) => Record<string, string> = (_id, v) => v
  ) {}

  config(id: IntegrationId): Record<string, string> {
    const stored = (this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(configKey(id)) as { value: string } | undefined)?.value
    const values = this.migrateConfig(id, stored ? (JSON.parse(stored) as Record<string, string>) : {})
    for (const f of this.specs[id].config) if ((values[f.key] === undefined || values[f.key] === '') && f.default !== undefined) values[f.key] = f.default
    return values
  }

  secret(id: IntegrationId, key: string): string | null {
    const value = this.secrets.get(secretName(id, key))
    registerSecret(value)
    return value
  }

  isConfigured(id: IntegrationId): boolean {
    const spec = this.specs[id]
    const cfg = this.config(id)
    return spec.config.every((f) => !f.required || cfg[f.key]) && spec.secrets.every((f) => !f.required || this.secrets.hint(secretName(id, f.key)))
  }

  private status(id: IntegrationId): StatusRow | undefined {
    return this.db.prepare('SELECT state, message, checked_at, last_success_at, details FROM integration_status WHERE integration = ?').get(id) as StatusRow | undefined
  }

  private storedDetails(id: IntegrationId): Record<string, unknown> {
    if (!this.details.has(id)) {
      const raw = this.status(id)?.details
      this.details.set(id, raw ? (JSON.parse(raw) as Record<string, unknown>) : {})
    }
    return this.details.get(id)!
  }

  private ctx(id: IntegrationId, progress = true): ActionContext {
    return { config: this.config(id), secret: (k) => this.secret(id, k), progress: progress ? (step) => this.onProgress(id, step) : () => {} }
  }

  view(id: IntegrationId): IntegrationView {
    const spec = this.specs[id]
    const status = this.status(id)
    const configured = this.isConfigured(id)
    const details = this.storedDetails(id)
    let extras: Record<string, unknown> = {}
    try {
      extras = spec.extras ? spec.extras(this.ctx(id, false), details) : {}
    } catch (err) {
      extras = { error: describeError(err) }
    }
    return {
      id,
      state: !configured ? 'not_configured' : (status?.state ?? 'untested'),
      message: configured ? (status?.message ?? null) : null,
      checkedAt: configured ? (status?.checked_at ?? null) : null,
      lastSuccessAt: status?.last_success_at ?? null,
      lastAction: (details.lastAction as IntegrationActionResult | undefined) ?? null,
      config: this.config(id),
      secrets: Object.fromEntries(spec.secrets.map((f) => [f.key, this.secrets.hint(secretName(id, f.key))])),
      extras
    }
  }

  list(): IntegrationView[] {
    return (Object.keys(this.specs) as IntegrationId[]).map((id) => this.view(id))
  }

  save(input: IntegrationSaveInput): IntegrationView {
    const spec = this.specs[input.id]
    if (!spec) throw new UserError('validation_failed', 'Unknown integration')
    const fields: Record<string, string> = {}
    const config: Record<string, string> = {}
    for (const f of spec.config) {
      const val = (input.config[f.key] ?? '').trim()
      if (!val && f.required && f.default === undefined) fields[f.key] = 'Required'
      else if (val && f.validate) {
        const problem = f.validate(val)
        if (problem) fields[f.key] = problem
      }
      config[f.key] = val
    }
    for (const f of spec.secrets) {
      const val = input.secrets[f.key]
      const stored = this.secrets.hint(secretName(input.id, f.key))
      if (val === undefined) {
        if (f.required && !stored) fields[f.key] = 'Required'
        continue
      }
      if (val.trim() === '' && f.required) fields[f.key] = 'Required'
      else if (val.trim() && f.key !== 'password' && /\s/.test(val.trim())) fields[f.key] = 'Must not contain spaces'
      else if (val.trim() && f.validate) {
        const problem = f.validate(val.trim())
        if (problem) fields[f.key] = problem
      }
    }
    if (Object.keys(fields).length) throw new UserError('validation_failed', 'Please correct the highlighted fields.', fields)

    for (const f of spec.secrets) {
      const val = input.secrets[f.key]
      if (val === undefined) continue
      if (val.trim() === '') this.secrets.delete(secretName(input.id, f.key))
      else {
        const clean = f.key === 'password' ? val : val.trim()
        this.secrets.set(secretName(input.id, f.key), clean)
        registerSecret(clean)
      }
    }
    this.db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(configKey(input.id), JSON.stringify(config), new Date().toISOString())
    // Changed settings invalidate the previous test result (the last success time is kept as history).
    this.db.prepare(`INSERT INTO integration_status (integration, state) VALUES (?, 'untested')
      ON CONFLICT(integration) DO UPDATE SET state = 'untested', message = NULL, checked_at = NULL`).run(input.id)
    return this.view(input.id)
  }

  clear(id: IntegrationId): IntegrationView {
    for (const f of this.specs[id].secrets) this.secrets.delete(secretName(id, f.key))
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(configKey(id))
    this.db.prepare('DELETE FROM integration_status WHERE integration = ?').run(id)
    this.details.delete(id)
    return this.view(id)
  }

  private persist(id: IntegrationId, patch: Partial<StatusRow>, details: Record<string, unknown>) {
    const cur = this.status(id)
    const next = { state: cur?.state ?? 'untested', message: cur?.message ?? null, checked_at: cur?.checked_at ?? null, last_success_at: cur?.last_success_at ?? null, ...patch }
    this.details.set(id, details)
    this.db.prepare(
      `INSERT INTO integration_status (integration, state, message, checked_at, last_success_at, details) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(integration) DO UPDATE SET state = excluded.state, message = excluded.message, checked_at = excluded.checked_at,
         last_success_at = excluded.last_success_at, details = excluded.details`
    ).run(id, next.state, next.message, next.checked_at, next.last_success_at, JSON.stringify(details))
  }

  /** Runs "test" or a named action against the real provider and stores the actual outcome. */
  async run(id: IntegrationId, action: string, params: Record<string, unknown> = {}): Promise<{ view: IntegrationView; result: IntegrationActionResult }> {
    const spec = this.specs[id]
    const fn = action === 'test' ? (ctx: ActionContext) => spec.test(ctx) : spec.actions?.[action]
    if (!fn) throw new UserError('bad_request', `Unknown action ${action}`)
    if (!this.isConfigured(id)) throw new UserError('not_configured', 'Save the required settings before running this.')
    const ctx = this.ctx(id)
    const at = new Date().toISOString()
    let result: IntegrationActionResult
    try {
      ctx.progress(action === 'test' ? 'Contacting provider…' : 'Working…')
      const message = redact(await fn(ctx, params))
      result = { action, ok: true, message, at }
      // re-read: the action may have stored data with remember()
      const details = { ...this.storedDetails(id), lastAction: result }
      this.persist(id, { state: 'connected', message: action === 'test' ? message : (this.status(id)?.message ?? message), checked_at: at, last_success_at: at }, details)
    } catch (err) {
      const message = describeError(err)
      result = { action, ok: false, message, at }
      const details = { ...this.storedDetails(id), lastAction: result }
      // Only a failed connection test marks the integration as failed; e.g. a rejected test recipient does not.
      if (action === 'test') this.persist(id, { state: 'failed', message, checked_at: at }, details)
      else this.persist(id, {}, details)
    } finally {
      ctx.progress('')
    }
    return { view: this.view(id), result }
  }

  /** Lets an action stash data (e.g. the fetched model list) into persisted details. */
  remember(id: IntegrationId, key: string, value: unknown): void {
    const d = { ...this.storedDetails(id), [key]: value }
    const cur = this.status(id)
    this.persist(id, { state: cur?.state ?? 'untested' }, d)
  }

  detail<T>(id: IntegrationId, key: string): T | undefined {
    return this.storedDetails(id)[key] as T | undefined
  }
}
