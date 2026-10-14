import { ProviderError, requestJson } from '../net.js'
import { AiError, parseJsonOutput, type AiJsonRequest, type AiJsonResult, type AiModel, type AiProvider, type AiSettings } from './provider.js'

const BASE = 'https://api.openai.com/v1'
const CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/
const NON_CHAT = /(audio|realtime|tts|transcribe|image|embedding|search|moderation|instruct|dall-e|whisper|computer-use)/

interface OpenAiErrorBody {
  error?: { message?: string; type?: string; code?: string | null }
}

function toAiError(status: number, body: OpenAiErrorBody | null): AiError {
  const code = body?.error?.code ?? body?.error?.type ?? ''
  const msg = body?.error?.message ?? `HTTP ${status}`
  if (status === 401) return new AiError('auth', 'OpenAI rejected the API key (401). Check that it is active and copied in full.')
  if (status === 403) return new AiError('permission', `OpenAI denied access (403): ${msg}`)
  if (status === 404) return new AiError('model', `Model not available to this key: ${msg}`)
  if (status === 429 && code === 'insufficient_quota') return new AiError('quota', 'OpenAI quota exhausted for this account (insufficient_quota). Add credit or raise the limit in your OpenAI billing settings.')
  if (status === 429) return new AiError('rate_limited', 'OpenAI rate limit reached. Try again shortly.')
  if (status === 400) return new AiError('invalid_request', `OpenAI rejected the request: ${msg}`)
  return new AiError('provider', `OpenAI error (HTTP ${status}): ${msg}`)
}

export class OpenAiProvider implements AiProvider {
  readonly id = 'openai' as const

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep?: (ms: number) => Promise<void>
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }
  }

  private async call<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number; attempts?: number }): Promise<T> {
    let res
    try {
      res = await requestJson<T & OpenAiErrorBody>(BASE + path, {
        method: init.method ?? 'GET',
        headers: this.headers(),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        timeoutMs: init.timeoutMs ?? 15_000,
        attempts: init.attempts,
        fetchImpl: this.fetchImpl,
        sleep: this.sleep
      })
    } catch (err) {
      if (err instanceof ProviderError) throw new AiError(err.kind === 'timeout' ? 'timeout' : err.kind === 'rate_limited' ? 'rate_limited' : 'network', err.kind === 'timeout' ? 'OpenAI did not respond in time.' : 'Could not reach api.openai.com.')
      throw err
    }
    if (res.status >= 400 || !res.body) throw toAiError(res.status, res.body)
    return res.body
  }

  async listModels(): Promise<AiModel[]> {
    const body = await this.call<{ data?: { id: string; created?: number }[] }>('/models', {})
    if (!Array.isArray(body.data)) throw new AiError('provider', 'Unexpected response from OpenAI /models.')
    return body.data
      .filter((m) => typeof m.id === 'string' && CHAT_MODEL.test(m.id) && !NON_CHAT.test(m.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map((m) => ({ id: m.id, label: m.id }))
  }

  async test(): Promise<string> {
    const models = await this.listModels()
    return `Authenticated with OpenAI. ${models.length} chat-capable models available to this key.`
  }

  /** Chat Completions with a strict JSON schema; retries only on 429/5xx, at most once. */
  async generateJson(req: AiJsonRequest, s: AiSettings): Promise<AiJsonResult> {
    const body = await this.call<{
      model?: string
      choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }>('/chat/completions', {
      method: 'POST',
      timeoutMs: s.timeoutSec * 1000,
      attempts: 2,
      body: {
        model: s.model,
        messages: [{ role: 'system', content: req.system }, ...req.messages.map((m) => ({ role: m.role, content: m.content }))],
        max_completion_tokens: s.maxOutputTokens,
        response_format: { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: req.schema } }
      }
    })
    const choice = body.choices?.[0]
    const usage = { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 }
    const fail = (e: AiError) => Object.assign(e, { usage })
    if (!choice?.message) throw fail(new AiError('provider', 'OpenAI returned no message.'))
    if (choice.message.refusal) throw fail(new AiError('refusal', `The model declined: ${choice.message.refusal}`))
    if (choice.finish_reason === 'length') throw fail(new AiError('truncated', 'The answer hit the output-token limit. Raise "Max output tokens" in Settings.'))
    if (!choice.message.content) throw fail(new AiError('invalid_output', 'OpenAI returned an empty answer.'))
    return { data: parseJsonOutput(choice.message.content), model: body.model ?? s.model, ...usage }
  }
}
