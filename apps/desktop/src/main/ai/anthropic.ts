import Anthropic from '@anthropic-ai/sdk'
import { AiError, parseJsonOutput, type AiJsonRequest, type AiJsonResult, type AiModel, type AiProvider, type AiSettings } from './provider.js'

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5'
/** Models that accept server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])
/** Effort is rejected on older models (e.g. Haiku 4.5, Sonnet 4.5). */
const EFFORT_MODEL = /^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable-|mythos-|haiku-5)/

function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err
  if (err instanceof Anthropic.AuthenticationError) return new AiError('auth', 'Anthropic rejected the API key (401).')
  if (err instanceof Anthropic.PermissionDeniedError) return new AiError('permission', 'This Anthropic key is not permitted to use this model or feature (403).')
  if (err instanceof Anthropic.NotFoundError) return new AiError('model', 'Model not found for this key (404). Refresh the model list and choose another.')
  if (err instanceof Anthropic.RateLimitError) return new AiError('rate_limited', 'Anthropic rate limit reached (429). Try again shortly.')
  if (err instanceof Anthropic.BadRequestError) return new AiError('invalid_request', `Anthropic rejected the request: ${err.message}`)
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AiError('timeout', 'Anthropic did not respond in time.')
  if (err instanceof Anthropic.APIConnectionError) return new AiError('network', 'Could not reach api.anthropic.com.')
  if (err instanceof Anthropic.APIError) return new AiError('provider', `Anthropic API error ${err.status ?? ''}: ${err.message}`)
  return new AiError('provider', err instanceof Error ? err.message : String(err))
}

export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic' as const
  private readonly client: Anthropic

  constructor(apiKey: string, fetchImpl?: typeof fetch) {
    // The SDK retries 408/409/429/5xx and connection errors; keep it bounded.
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000, ...(fetchImpl ? { fetch: fetchImpl } : {}) })
  }

  async listModels(): Promise<AiModel[]> {
    try {
      const page = await this.client.models.list({ limit: 100 }, { timeout: 15_000 })
      return page.data.map((m) => ({ id: m.id, label: m.display_name ?? m.id }))
    } catch (err) {
      throw toAiError(err)
    }
  }

  async test(): Promise<string> {
    const models = await this.listModels()
    return `Authenticated with Anthropic. ${models.length} models available${models[0] ? ` (newest: ${models[0].label})` : ''}.`
  }

  async generateJson(req: AiJsonRequest, s: AiSettings): Promise<AiJsonResult> {
    const fallback = FALLBACK_MODELS.has(s.model)
    let msg
    try {
      msg = await this.client.beta.messages.create(
        {
          model: s.model,
          max_tokens: s.maxOutputTokens,
          system: req.system,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          output_config: { format: { type: 'json_schema', schema: req.schema }, ...(EFFORT_MODEL.test(s.model) ? { effort: 'low' as const } : {}) },
          // If the model declines on policy grounds, the API retries on a fallback model in the same call.
          ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
        },
        { timeout: s.timeoutSec * 1000 }
      )
    } catch (err) {
      throw toAiError(err)
    }
    const usage = { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens }
    const fail = (e: AiError) => Object.assign(e, { usage })
    if (msg.stop_reason === 'refusal') throw fail(new AiError('refusal', 'The model declined this request.'))
    if (msg.stop_reason === 'max_tokens') throw fail(new AiError('truncated', 'The answer hit the output-token limit. Raise "Max output tokens" in Settings.'))
    const text = msg.content.filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('')
    if (!text) throw fail(new AiError('invalid_output', 'Anthropic returned no text output.'))
    return { data: parseJsonOutput(text), model: msg.model, ...usage }
  }
}
