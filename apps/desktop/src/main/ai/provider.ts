import type { Db } from '../db.js'
import { UserError } from '../errors.js'

export type AiProviderId = 'openai' | 'anthropic'

/** User-configurable limits, stored with each provider's (non-secret) settings. */
export interface AiSettings {
  model: string
  maxOutputTokens: number
  timeoutSec: number
  dailyRequestLimit: number
  dailyTokenLimit: number
}

export interface AiJsonRequest {
  purpose: string
  system: string
  /** Conversation so far, oldest first; must end with a user message. */
  messages: { role: 'user' | 'assistant'; content: string }[]
  schemaName: string
  schema: Record<string, unknown>
}

export interface AiJsonResult {
  data: unknown
  model: string
  inputTokens: number
  outputTokens: number
}

export interface AiModel {
  id: string
  label: string
}

/** Common surface for OpenAI and Anthropic. Providers only return data; nothing here can trade. */
export interface AiProvider {
  readonly id: AiProviderId
  listModels(): Promise<AiModel[]>
  /** Lightweight authenticated call proving the key works. */
  test(): Promise<string>
  generateJson(req: AiJsonRequest, settings: AiSettings): Promise<AiJsonResult>
}

export class AiError extends Error {
  constructor(
    readonly code: 'auth' | 'permission' | 'rate_limited' | 'quota' | 'model' | 'refusal' | 'truncated' | 'invalid_output' | 'timeout' | 'network' | 'provider' | 'invalid_request',
    message: string
  ) {
    super(message)
  }
}

export interface UsageSummary {
  provider: AiProviderId
  requestsToday: number
  tokensToday: number
  failedToday: number
  dailyRequestLimit: number
  dailyTokenLimit: number
}

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()

export class AiUsageTracker {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date()
  ) {}

  summary(provider: AiProviderId, s: AiSettings): UsageSummary {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens + output_tokens), 0) AS t, COALESCE(SUM(1 - ok), 0) AS f FROM ai_usage WHERE provider = ? AND created_at >= ?`
    ).get(provider, startOfUtcDay(this.now())) as { n: number; t: number; f: number }
    return { provider, requestsToday: row.n, tokensToday: row.t, failedToday: row.f, dailyRequestLimit: s.dailyRequestLimit, dailyTokenLimit: s.dailyTokenLimit }
  }

  /** Throws before a request that would exceed the configured daily limits (UTC day). */
  assertWithinLimits(provider: AiProviderId, s: AiSettings): void {
    const u = this.summary(provider, s)
    if (u.requestsToday >= s.dailyRequestLimit) {
      throw new UserError('ai_limit', `Daily ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} request limit reached (${s.dailyRequestLimit}). Raise it in Settings or try again tomorrow (UTC).`)
    }
    if (u.tokensToday + s.maxOutputTokens > s.dailyTokenLimit) {
      throw new UserError('ai_limit', `Daily ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} token budget would be exceeded (${u.tokensToday.toLocaleString()} of ${s.dailyTokenLimit.toLocaleString()} used).`)
    }
  }

  record(provider: AiProviderId, model: string, purpose: string, r: { inputTokens: number; outputTokens: number; ok: boolean; errorCode?: string }): void {
    this.db.prepare('INSERT INTO ai_usage (provider, model, purpose, input_tokens, output_tokens, ok, error_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(provider, model, purpose, Math.max(0, r.inputTokens), Math.max(0, r.outputTokens), r.ok ? 1 : 0, r.errorCode ?? null, this.now().toISOString())
  }
}

/** Enforces limits and records usage around one provider call. */
export async function runJson(provider: AiProvider, tracker: AiUsageTracker, req: AiJsonRequest, s: AiSettings): Promise<AiJsonResult> {
  tracker.assertWithinLimits(provider.id, s)
  try {
    const result = await provider.generateJson(req, s)
    tracker.record(provider.id, result.model, req.purpose, { inputTokens: result.inputTokens, outputTokens: result.outputTokens, ok: true })
    return result
  } catch (err) {
    const code = err instanceof AiError ? err.code : 'provider'
    const usage = (err as { usage?: { inputTokens: number; outputTokens: number } }).usage
    tracker.record(provider.id, s.model, req.purpose, { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, ok: false, errorCode: code })
    if (err instanceof AiError) throw new UserError(`ai_${err.code}`, err.message)
    throw err
  }
}

export function parseJsonOutput(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new AiError('invalid_output', 'The model did not return valid JSON.')
  }
}
