import { UserError } from './errors.js'
import type { Candle, Ticker, Timeframe } from '../shared/ipc.js'

const TF_SECONDS: Record<Timeframe, number> = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }
export { MAX_BACKTEST_DAYS as MAX_DAYS } from '../shared/strategySpec.js'
import { MAX_BACKTEST_DAYS as MAX_DAYS } from '../shared/strategySpec.js'
const PAGE_BARS = 2000

interface RawTicker {
  symbol: string
  description?: string
  mark_price?: string | number
  close?: number
  open?: number
  high?: number
  low?: number
  turnover_usd?: number
  funding_rate?: string | number
  contract_type?: string
  timestamp?: number
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

/** Public Delta Exchange market data (no credentials required). */
export class MarketData {
  private tickerCache: { at: number; data: Ticker[] } | null = null

  constructor(private readonly baseUrl: () => string) {}

  private async get<T>(path: string): Promise<T> {
    let res: Response
    try {
      res = await fetch(this.baseUrl() + path, { headers: { Accept: 'application/json', 'User-Agent': 'TradePilot' }, signal: AbortSignal.timeout(15_000) })
    } catch {
      throw new UserError('market_unreachable', 'Market data is unavailable: Delta Exchange could not be reached.')
    }
    const body = (await res.json().catch(() => null)) as { success?: boolean; result?: T; error?: { code?: string } } | null
    if (!res.ok || !body?.success) throw new UserError('market_error', `Market data request failed (${body?.error?.code ?? `HTTP ${res.status}`}).`)
    return body.result as T
  }

  async allTickers(): Promise<Ticker[]> {
    if (this.tickerCache && Date.now() - this.tickerCache.at < 4000) return this.tickerCache.data
    const raw = await this.get<RawTicker[]>('/v2/tickers?contract_types=perpetual_futures')
    const data = raw
      .map((t): Ticker | null => {
        const mark = num(t.mark_price)
        const last = num(t.close) ?? mark
        if (mark === null || last === null) return null
        const open = num(t.open)
        return {
          symbol: t.symbol,
          description: t.description ?? t.symbol,
          markPrice: mark,
          lastPrice: last,
          change24hPct: open ? ((last - open) / open) * 100 : null,
          high24h: num(t.high),
          low24h: num(t.low),
          volume24hUsd: num(t.turnover_usd),
          fundingRate: num(t.funding_rate),
          updatedAt: t.timestamp ? new Date(t.timestamp / 1000).toISOString() : new Date().toISOString()
        }
      })
      .filter((t): t is Ticker => t !== null)
      .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0))
    this.tickerCache = { at: Date.now(), data }
    return data
  }

  async tickers(symbols?: string[]): Promise<Ticker[]> {
    const all = await this.allTickers()
    if (!symbols?.length) return all.slice(0, 12)
    const wanted = new Set(symbols)
    return all.filter((t) => wanted.has(t.symbol))
  }

  async markPrice(symbol: string): Promise<number> {
    this.tickerCache = null
    const t = (await this.allTickers()).find((x) => x.symbol === symbol)
    if (!t) throw new UserError('unknown_symbol', `${symbol} is not an active perpetual contract.`)
    return t.markPrice
  }

  async candles(symbol: string, timeframe: Timeframe, days: number): Promise<Candle[]> {
    if (!/^[A-Z0-9_]{2,32}$/.test(symbol)) throw new UserError('validation_failed', 'Invalid symbol')
    const step = TF_SECONDS[timeframe]
    if (!step) throw new UserError('validation_failed', 'Invalid timeframe')
    const span = Math.max(1, Math.min(days, MAX_DAYS[timeframe])) * 86400
    const end = Math.floor(Date.now() / 1000)
    const start = end - span
    const out = new Map<number, Candle>()
    for (let from = start; from < end; from += step * PAGE_BARS) {
      const to = Math.min(end, from + step * PAGE_BARS)
      const rows = await this.get<{ time: number; open: number; high: number; low: number; close: number; volume: number }[]>(
        `/v2/history/candles?resolution=${timeframe}&symbol=${encodeURIComponent(symbol)}&start=${from}&end=${to}`
      )
      for (const r of rows) out.set(r.time, { time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 })
    }
    return [...out.values()].sort((a, b) => a.time - b.time)
  }
}
