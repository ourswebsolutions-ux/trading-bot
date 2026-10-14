/**
 * Redacts credentials from anything that may be logged or shown. Known secret values are
 * registered when they are stored or read; patterns catch common token formats as a backstop.
 */
const known = new Set<string>()

export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 6) known.add(value)
}

const PATTERNS: [RegExp, string][] = [
  [/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{8})[A-Za-z0-9_-]{8,}/g, '$1…[redacted]'],
  [/\bEAA[A-Za-z0-9]{20,}/g, '[redacted-meta-token]'],
  [/(authorization|x-api-key|api-key|signature|access_token|password|pass)(["']?\s*[:=]\s*["']?)(Bearer\s+)?[^\s"',}&]+/gi, '$1$2[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]']
]

export function redact(input: string): string {
  let out = input
  for (const secret of known) if (out.includes(secret)) out = out.split(secret).join('[redacted]')
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep)
  return out
}

export function redactValue(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return redact(value)
  if (value instanceof Error) return redact(value.stack ?? value.message)
  try {
    return redact(JSON.stringify(value))
  } catch {
    return redact(String(value))
  }
}
