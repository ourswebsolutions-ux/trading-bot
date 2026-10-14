import { redact } from './redact.js'

/** Classified provider/network failure with a message that is safe to show. */
export class ProviderError extends Error {
  constructor(
    readonly kind: 'network' | 'timeout' | 'auth' | 'permission' | 'rate_limited' | 'region_blocked' | 'not_found' | 'invalid_request' | 'bad_response' | 'provider',
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly providerCode?: string
  ) {
    super(redact(message))
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** Total attempts for idempotent requests (default 3 for GET, 1 otherwise). */
  attempts?: number
  /** Called before each attempt, e.g. to refresh a timestamp signature. */
  beforeAttempt?: (headers: Record<string, string>) => Record<string, string>
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export interface JsonResponse<T = unknown> {
  status: number
  headers: Headers
  body: T | null
  text: string
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
export const MAX_RETRY_DELAY_MS = 10_000

function retryAfter(res: Response): number | undefined {
  const ra = res.headers.get('retry-after')
  if (ra) {
    const secs = Number(ra)
    if (Number.isFinite(secs)) return secs * 1000
    const at = Date.parse(ra)
    if (Number.isFinite(at)) return Math.max(0, at - Date.now())
  }
  const reset = res.headers.get('x-rate-limit-reset') // Delta: milliseconds until the window resets
  if (reset && Number.isFinite(Number(reset))) return Number(reset)
  return undefined
}

/**
 * fetch with a hard timeout and bounded retries (network errors, 429, 5xx) for
 * idempotent requests. Never retries a POST unless explicitly asked to.
 */
export async function requestJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<JsonResponse<T>> {
  const method = opts.method ?? 'GET'
  const attempts = Math.max(1, Math.min(opts.attempts ?? (method === 'GET' ? 3 : 1), 5))
  const sleep = opts.sleep ?? defaultSleep
  const doFetch = opts.fetchImpl ?? fetch
  let lastError: ProviderError | null = null

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const headers = opts.beforeAttempt ? opts.beforeAttempt({ ...(opts.headers ?? {}) }) : { ...(opts.headers ?? {}) }
    let res: Response
    try {
      res = await doFetch(url, { method, headers, body: opts.body, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) })
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      lastError = new ProviderError(timedOut ? 'timeout' : 'network', timedOut ? `Request timed out after ${(opts.timeoutMs ?? 15_000) / 1000}s.` : 'Network error: the service could not be reached.')
      if (attempt < attempts) await sleep(Math.min(MAX_RETRY_DELAY_MS, 500 * 2 ** (attempt - 1)))
      continue
    }
    const text = await res.text()
    let body: T | null = null
    try {
      body = text ? (JSON.parse(text) as T) : null
    } catch {
      body = null
    }
    const retryable = res.status === 429 || res.status >= 500
    if (retryable && attempt < attempts) {
      const wait = Math.min(MAX_RETRY_DELAY_MS, retryAfter(res) ?? 500 * 2 ** (attempt - 1))
      lastError = new ProviderError(res.status === 429 ? 'rate_limited' : 'provider', `HTTP ${res.status}`, res.status, wait)
      await sleep(wait)
      continue
    }
    return { status: res.status, headers: res.headers, body, text }
  }
  throw lastError ?? new ProviderError('network', 'Request failed')
}
