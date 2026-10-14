export function money(n: number | null | undefined, opts: { currency?: string; digits?: number; sign?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const s = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: opts.currency ?? 'USD',
    minimumFractionDigits: opts.digits ?? 2,
    maximumFractionDigits: opts.digits ?? 2
  }).format(n)
  return opts.sign && n > 0 ? `+${s}` : s
}

export function cents(n: number, currency = 'USD'): string {
  const digits = n % 100 === 0 ? 0 : 2
  return money(n / 100, { currency, digits })
}

/** Price with precision adapted to magnitude (BTC vs. small-cap contracts). */
export function price(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const digits = abs >= 1000 ? 1 : abs >= 1 ? 3 : abs >= 0.01 ? 5 : 7
  return n.toLocaleString('en-US', { minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits })
}

export function pct(n: number | null | undefined, digits = 2, sign = true): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return `${sign && n > 0 ? '+' : ''}${n.toFixed(digits)}%`
}

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

export function qty(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 })
}

export function duration(ms: number, withSeconds = true): string {
  if (ms <= 0) return '0s'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const parts = d ? [`${d}d`, `${h}h`, `${m}m`] : h ? [`${h}h`, `${String(m).padStart(2, '0')}m`] : [`${m}m`]
  if (withSeconds && !d) parts.push(`${String(sec).padStart(2, '0')}s`)
  return parts.join(' ')
}

export function dateTime(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined) return '—'
  const d = typeof iso === 'number' ? new Date(iso * 1000) : new Date(iso)
  return d.toLocaleString('en-GB', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: '2-digit' })
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export const STRATEGY_LABELS: Record<string, string> = {
  sma_cross: 'SMA crossover',
  ema_cross: 'EMA crossover',
  rsi_reversion: 'RSI mean reversion',
  breakout: 'Channel breakout'
}
