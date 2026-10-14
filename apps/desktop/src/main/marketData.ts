import { UserError } from './errors.js'
import { ProviderError } from './net.js'
import { DeltaRest, TickerSchema, type DeltaTicker } from './delta/rest.js'
import { DELTA_REGIONS, type DeltaRegion } from './delta/regions.js'
import { DeltaSocket, type SocketState, type SocketTimers, type WebSocketFactory } from './delta/socket.js'
import type { Candle, CandleGap, CandleSeries, DataState, Instrument, LiveCandle, MarketHealth, MarketSnapshot, Quote, Ticker, Timeframe } from '../shared/ipc.js'
export { MAX_BACKTEST_DAYS as MAX_DAYS } from '../shared/strategySpec.js'
import { MAX_BACKTEST_DAYS as MAX_DAYS } from '../shared/strategySpec.js'

export const TF_SECONDS: Record<Timeframe, number> = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }
const PAGE_BARS = 2000
const INSTRUMENTS_TTL_MS = 60 * 60_000

export interface MarketSettings {
  useWebSocket: boolean
  staleAfterSec: number
  pollIntervalSec: number
}
export const DEFAULT_MARKET_SETTINGS: MarketSettings = { useWebSocket: true, staleAfterSec: 15, pollIntervalSec: 10 }

/** Expected-vs-actual candle times; exchanges skip intervals with no trades, which is reported, never filled in. */
export function findGaps(candles: Candle[], stepSec: number): CandleGap[] {
  const gaps: CandleGap[] = []
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i]!.time - candles[i - 1]!.time
    if (delta > stepSec) gaps.push({ from: candles[i - 1]!.time + stepSec, to: candles[i]!.time - stepSec, missing: Math.round(delta / stepSec) - 1 })
  }
  return gaps
}

export function classify(q: { quote: { source: 'websocket' | 'rest' }; receivedAtMs: number } | undefined, now: number, socketOpen: boolean, s: MarketSettings): DataState {
  if (!q) return 'unavailable'
  const age = now - q.receivedAtMs
  const staleAfter = s.staleAfterSec * 1000
  if (q.quote.source === 'websocket' && socketOpen && age <= staleAfter) return 'live'
  if (age <= Math.max(staleAfter, s.pollIntervalSec * 2000)) return 'delayed'
  return 'stale'
}

interface QuoteState {
  quote: Omit<Quote, 'state'>
  exchangeMicros: number
  receivedAtMs: number
}

function toQuote(t: DeltaTicker, source: 'websocket' | 'rest', receivedAtMs: number): Omit<Quote, 'state'> {
  const last = t.close ?? t.mark_price ?? null
  return {
    symbol: t.symbol,
    lastPrice: last,
    markPrice: t.mark_price ?? null,
    bid: t.quotes?.best_bid ?? null,
    ask: t.quotes?.best_ask ?? null,
    change24hPct: t.open && last !== null ? ((last - t.open) / t.open) * 100 : null,
    high24h: t.high ?? null,
    low24h: t.low ?? null,
    volume24hUsd: t.turnover_usd ?? null,
    fundingRate: t.funding_rate ?? null,
    exchangeTime: t.timestamp ? new Date(t.timestamp / 1000).toISOString() : null,
    receivedAt: new Date(receivedAtMs).toISOString(),
    source
  }
}

export interface MarketDataDeps {
  region: () => DeltaRegion
  settings: () => MarketSettings
  onSnapshot: (s: MarketSnapshot) => void
  onCandle: (c: LiveCandle) => void
  restFactory?: (region: DeltaRegion) => DeltaRest
  socketFactory?: WebSocketFactory
  timers?: SocketTimers
  now?: () => number
  log?: (msg: string) => void
}

/**
 * Single owner of Delta Exchange market data. Views register what they display; the
 * service streams it over WebSocket when possible and falls back to REST polling, and
 * every quote carries its source and freshness so nothing old is ever shown as live.
 */
export class MarketDataService {
  private region: DeltaRegion
  private rest: DeltaRest
  private socket: DeltaSocket | null = null
  private socketState: SocketState | 'disabled' = 'disabled'
  private quotes = new Map<string, QuoteState>()
  private watchers = new Map<string, Set<string>>()
  private charts = new Map<string, { symbol: string; timeframe: Timeframe }>()
  private candleVersions = new Map<string, number>()
  private instrumentsCache: { at: number; list: Instrument[] } | null = null
  private instrumentsLoading: Promise<Instrument[]> | null = null
  private tickerCache: { at: number; list: Ticker[] } | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private emitTimer: NodeJS.Timeout | null = null
  private epoch = 0
  private lastRestAt: number | null = null
  private restError: string | null = null
  private duplicates = 0
  private unsupported = new Set<string>()
  private readonly now: () => number

  constructor(private readonly d: MarketDataDeps) {
    this.now = d.now ?? (() => Date.now())
    this.region = d.region()
    this.rest = this.makeRest(this.region)
  }

  private makeRest(region: DeltaRegion) {
    return this.d.restFactory ? this.d.restFactory(region) : new DeltaRest(region)
  }

  // ---------- lifecycle ----------
  start(): void {
    this.applySettings()
    void this.instruments().catch(() => undefined)
  }

  /** Re-reads region and settings; reconnects only if something changed. */
  applySettings(): void {
    const region = this.d.region()
    if (region !== this.region) {
      this.region = region
      this.rest = this.makeRest(region)
      this.quotes.clear()
      this.instrumentsCache = null
      this.tickerCache = null
      this.unsupported.clear()
      this.socket?.stop()
      this.socket = null
    }
    const s = this.d.settings()
    if (s.useWebSocket && !this.socket) {
      this.socket = new DeltaSocket(
        DELTA_REGIONS[this.region].ws,
        {
          onMessage: (m) => this.onSocketMessage(m),
          onState: (state, detail) => {
            this.socketState = state
            if (state === 'open') this.epoch++
            if (detail.error) this.d.log?.(`market socket ${state}: ${detail.error}`)
            this.schedulePoll(0)
            this.emitSoon()
          }
        },
        this.d.socketFactory,
        this.d.timers
      )
      this.syncSubscriptions()
      if (this.watchedSymbols().size > 0 || this.charts.size > 0) this.socket.start()
    } else if (!s.useWebSocket && this.socket) {
      this.socket.stop()
      this.socket = null
      this.socketState = 'disabled'
    }
    this.schedulePoll(0)
    this.emitSoon()
  }

  stop(): void {
    this.socket?.stop()
    this.socket = null
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.pollTimer = null
  }

  // ---------- instruments ----------
  async instruments(force = false): Promise<Instrument[]> {
    if (!force && this.instrumentsCache && this.now() - this.instrumentsCache.at < INSTRUMENTS_TTL_MS) return this.instrumentsCache.list
    this.instrumentsLoading ??= this.rest
      .products()
      .then((products) => {
        const list = products
          .filter((p) => p.state === 'live')
          .map<Instrument>((p) => ({
            symbol: p.symbol,
            productId: p.id,
            settlingAsset: p.settling_asset?.symbol ?? null,
            description: p.description ?? p.symbol,
            underlying: p.underlying_asset?.symbol ?? null,
            quoteAsset: p.quoting_asset?.symbol ?? null,
            tickSize: p.tick_size,
            contractValue: p.contract_value ?? null,
            tradingStatus: p.trading_status ?? null
          }))
          .sort((a, b) => a.symbol.localeCompare(b.symbol))
        this.instrumentsCache = { at: this.now(), list }
        this.restError = null
        this.refreshUnsupported()
        return list
      })
      .catch((err) => {
        this.restError = err instanceof Error ? err.message : String(err)
        throw err
      })
      .finally(() => (this.instrumentsLoading = null))
    return this.instrumentsLoading
  }

  isSupported(symbol: string): boolean | null {
    if (!this.instrumentsCache) return null
    return this.instrumentsCache.list.some((i) => i.symbol === symbol)
  }

  async requireSupported(symbol: string): Promise<void> {
    if (!/^[A-Z0-9_]{2,32}$/.test(symbol)) throw new UserError('validation_failed', 'Invalid symbol')
    const list = await this.instruments()
    if (!list.some((i) => i.symbol === symbol)) {
      throw new UserError('unsupported_symbol', `${symbol} is not a live perpetual contract on ${DELTA_REGIONS[this.region].label}. Choose an instrument from this region.`)
    }
  }

  private refreshUnsupported() {
    this.unsupported.clear()
    for (const s of this.watchedSymbols()) if (this.isSupported(s) === false) this.unsupported.add(s)
    this.syncSubscriptions()
  }

  // ---------- subscriptions ----------
  private watchedSymbols(): Set<string> {
    const all = new Set<string>()
    for (const set of this.watchers.values()) for (const s of set) all.add(s)
    return all
  }

  /** A view (dashboard, trading…) declares the symbols it shows. Replaces its previous set. */
  watch(viewId: string, symbols: string[], chart?: { symbol: string; timeframe: Timeframe } | null): MarketSnapshot {
    this.watchers.set(viewId, new Set(symbols.slice(0, 50)))
    if (chart) this.charts.set(viewId, chart)
    else this.charts.delete(viewId)
    this.refreshUnsupported()
    if (this.socket && this.socketState !== 'open' && (this.watchedSymbols().size > 0 || this.charts.size > 0)) this.socket.start()
    this.schedulePoll(0)
    return this.snapshot()
  }

  unwatch(viewId: string): void {
    this.watchers.delete(viewId)
    this.charts.delete(viewId)
    this.syncSubscriptions()
  }

  private syncSubscriptions() {
    if (!this.socket) return
    const symbols = [...this.watchedSymbols()].filter((s) => this.isSupported(s) !== false)
    this.socket.setSubscription('v2/ticker', symbols)
    const byTf = new Map<Timeframe, Set<string>>()
    for (const c of this.charts.values()) {
      if (this.isSupported(c.symbol) === false) continue
      const set = byTf.get(c.timeframe) ?? new Set<string>()
      set.add(c.symbol)
      byTf.set(c.timeframe, set)
    }
    for (const tf of Object.keys(TF_SECONDS) as Timeframe[]) this.socket.setSubscription(`candlestick_${tf}`, [...(byTf.get(tf) ?? [])])
  }

  // ---------- incoming data ----------
  /** Applies a ticker update; returns false for duplicates / out-of-order events. */
  ingestTicker(t: DeltaTicker, source: 'websocket' | 'rest'): boolean {
    const micros = t.timestamp ?? 0
    const prev = this.quotes.get(t.symbol)
    if (prev && micros > 0 && micros <= prev.exchangeMicros) {
      this.duplicates++
      // a REST poll confirming the same tick still proves the data is current
      if (source === 'rest' && prev.quote.source === 'rest') prev.receivedAtMs = this.now()
      return false
    }
    const receivedAtMs = this.now()
    this.quotes.set(t.symbol, { quote: toQuote(t, source, receivedAtMs), exchangeMicros: micros, receivedAtMs })
    this.emitSoon()
    return true
  }

  private onSocketMessage(m: Record<string, unknown>) {
    const type = String(m.type ?? '')
    if (type === 'v2/ticker') {
      const parsed = TickerSchema.safeParse(m)
      if (parsed.success) this.ingestTicker(parsed.data, 'websocket')
      return
    }
    if (type.startsWith('candlestick_')) {
      const tf = String(m.resolution ?? type.slice('candlestick_'.length)) as Timeframe
      const symbol = String(m.symbol ?? '')
      const start = Number(m.candle_start_time)
      const updated = Number(m.last_updated ?? m.timestamp ?? 0)
      const vals = ['open', 'high', 'low', 'close'].map((k) => Number(m[k]))
      if (!(tf in TF_SECONDS) || !symbol || !Number.isFinite(start) || vals.some((x) => !Number.isFinite(x))) return
      const key = `${symbol}|${tf}|${start}`
      if ((this.candleVersions.get(key) ?? 0) >= updated) {
        this.duplicates++
        return
      }
      this.candleVersions.set(key, updated)
      if (this.candleVersions.size > 500) this.candleVersions.delete(this.candleVersions.keys().next().value!)
      const [open, high, low, close] = vals as [number, number, number, number]
      this.d.onCandle({
        symbol,
        timeframe: tf,
        candle: { time: Math.floor(start / 1_000_000), open, high, low, close, volume: Number(m.volume) || 0 },
        receivedAt: new Date(this.now()).toISOString()
      })
    }
  }

  // ---------- REST fallback polling ----------
  private schedulePoll(delayMs: number) {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => void this.poll(), delayMs)
    this.pollTimer.unref?.()
  }

  private async poll() {
    const s = this.d.settings()
    const streaming = this.socketState === 'open'
    const watched = [...this.watchedSymbols()]
    if (watched.length > 0) {
      const live = (sym: string) => classify(this.quotes.get(sym), this.now(), streaming, s) === 'live'
      // poll only what the stream is not currently covering
      if (!streaming || watched.some((sym) => !live(sym) && this.isSupported(sym) !== false)) {
        try {
          const all = await this.allTickers(true)
          const wanted = new Set(watched)
          for (const t of all) if (wanted.has(t.symbol)) this.ingestTicker(t.raw, 'rest')
          this.restError = null
        } catch (err) {
          this.restError = err instanceof Error ? err.message : String(err)
          this.emitSoon()
        }
      }
    }
    this.schedulePoll(s.pollIntervalSec * 1000)
  }

  /** REST snapshot of every perpetual's ticker (markets table, paper fills). Cached for 4 s. */
  async allTickers(force = false): Promise<(Ticker & { raw: DeltaTicker })[]> {
    if (!force && this.tickerCache && this.now() - this.tickerCache.at < 4000) return this.tickerCache.list as (Ticker & { raw: DeltaTicker })[]
    const raw = await this.rest.tickers()
    this.lastRestAt = this.now()
    const list = raw
      .filter((t) => (t.mark_price ?? t.close) !== null && (t.mark_price ?? t.close) !== undefined)
      .map((t) => {
        const q = toQuote(t, 'rest', this.now())
        return {
          raw: t,
          symbol: t.symbol,
          description: t.description ?? t.symbol,
          markPrice: (q.markPrice ?? q.lastPrice)!,
          lastPrice: (q.lastPrice ?? q.markPrice)!,
          change24hPct: q.change24hPct,
          high24h: q.high24h,
          low24h: q.low24h,
          volume24hUsd: q.volume24hUsd,
          fundingRate: q.fundingRate,
          updatedAt: q.exchangeTime ?? q.receivedAt
        }
      })
      .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0))
    this.tickerCache = { at: this.now(), list }
    return list
  }

  async tickers(symbols?: string[]): Promise<Ticker[]> {
    const all = (await this.allTickers()).map(({ raw: _raw, ...t }) => t)
    if (!symbols?.length) return all.slice(0, 12)
    const wanted = new Set(symbols)
    return all.filter((t) => wanted.has(t.symbol))
  }

  /** Price for paper fills: the streamed quote when live/delayed, otherwise a fresh REST read. */
  async markPrice(symbol: string): Promise<number> {
    const q = this.quotes.get(symbol)
    const state = classify(q, this.now(), this.socketState === 'open', this.d.settings())
    if (q && (state === 'live' || state === 'delayed') && (q.quote.markPrice ?? q.quote.lastPrice)) return (q.quote.markPrice ?? q.quote.lastPrice)!
    await this.requireSupported(symbol)
    const t = await this.rest.ticker(symbol)
    this.ingestTicker(t, 'rest')
    const price = t.mark_price ?? t.close
    if (!price) throw new UserError('no_price', `Delta Exchange returned no price for ${symbol}.`)
    return price
  }

  // ---------- candles ----------
  async series(symbol: string, timeframe: Timeframe, days: number): Promise<CandleSeries> {
    await this.requireSupported(symbol)
    const step = TF_SECONDS[timeframe]
    const span = Math.max(1, Math.min(days, MAX_DAYS[timeframe])) * 86400
    const end = Math.floor(this.now() / 1000)
    const start = end - span
    const out = new Map<number, Candle>()
    for (let from = start; from < end; from += step * PAGE_BARS) {
      const to = Math.min(end, from + step * PAGE_BARS)
      const rows = await this.rest.candles(symbol, timeframe, from, to)
      for (const r of rows) out.set(r.time, { time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 })
    }
    this.lastRestAt = this.now()
    const candles = [...out.values()].sort((a, b) => a.time - b.time)
    const gaps = findGaps(candles, step)
    return { symbol, timeframe, candles, gaps, missing: gaps.reduce((a, g) => a + g.missing, 0), fetchedAt: new Date(this.now()).toISOString(), source: 'historical' }
  }

  async candles(symbol: string, timeframe: Timeframe, days: number): Promise<Candle[]> {
    return (await this.series(symbol, timeframe, days)).candles
  }

  // ---------- snapshot ----------
  health(): MarketHealth {
    const s = this.d.settings()
    const socketOpen = this.socketState === 'open'
    return {
      region: this.region,
      regionLabel: DELTA_REGIONS[this.region].label,
      transport: socketOpen ? 'websocket' : this.restError ? 'offline' : 'rest',
      socket: this.socket ? (this.socketState === 'disabled' ? 'idle' : this.socketState) : 'disabled',
      connectionEpoch: this.epoch,
      lastMessageAt: this.socket?.lastMessageAt ? new Date(this.socket.lastMessageAt).toISOString() : null,
      lastRestAt: this.lastRestAt ? new Date(this.lastRestAt).toISOString() : null,
      reconnects: this.socket?.reconnects ?? 0,
      lastError: this.restError ?? (socketOpen ? null : (this.socket?.lastError ?? null)),
      instruments: this.instrumentsCache?.list.length ?? 0,
      instrumentsAt: this.instrumentsCache ? new Date(this.instrumentsCache.at).toISOString() : null,
      staleAfterMs: s.staleAfterSec * 1000,
      unsupported: [...this.unsupported],
      duplicatesIgnored: this.duplicates
    }
  }

  snapshot(): MarketSnapshot {
    const now = this.now()
    const socketOpen = this.socketState === 'open'
    const s = this.d.settings()
    const quotes: Record<string, Quote> = {}
    for (const sym of this.watchedSymbols()) {
      const q = this.quotes.get(sym)
      if (q) quotes[sym] = { ...q.quote, state: classify(q, now, socketOpen, s) }
    }
    return { health: this.health(), quotes, at: new Date(now).toISOString() }
  }

  private emitSoon() {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.d.onSnapshot(this.snapshot())
    }, 250)
    this.emitTimer.unref?.()
  }

  /** Connection test for Settings → Market Data: REST discovery, a ticker read and a live stream sample. */
  async test(symbol: string, factory?: WebSocketFactory): Promise<string> {
    const t0 = this.now()
    const instruments = await this.instruments(true)
    const restMs = this.now() - t0
    const sym = instruments.some((i) => i.symbol === symbol) ? symbol : instruments[0]?.symbol
    if (!sym) throw new ProviderError('provider', 'Delta Exchange returned no live instruments for this region.')
    const t = await this.rest.ticker(sym)
    const parts = [`REST OK in ${restMs} ms: ${instruments.length} live perpetuals`, `${sym} mark ${(t.mark_price ?? t.close)?.toLocaleString('en-US', { maximumFractionDigits: 2 })} at ${t.timestamp ? new Date(t.timestamp / 1000).toISOString().slice(11, 19) : '?'} UTC`]
    if (symbol !== sym) parts.push(`${symbol} is not listed in this region`)
    if (this.d.settings().useWebSocket) {
      const ms = await this.sampleStream(sym, factory ?? this.d.socketFactory)
      parts.push(`WebSocket first tick in ${(ms / 1000).toFixed(1)} s`)
    } else parts.push('WebSocket disabled (REST polling)')
    return parts.join(' · ')
  }

  private sampleStream(symbol: string, factory?: WebSocketFactory): Promise<number> {
    return new Promise((resolve, reject) => {
      const start = this.now()
      const timeout = setTimeout(() => {
        sock.stop()
        reject(new ProviderError('timeout', 'WebSocket connected but no ticker arrived within 15 s (firewall or proxy may block wss://).'))
      }, 15_000)
      const sock = new DeltaSocket(
        DELTA_REGIONS[this.region].ws,
        {
          onMessage: (m) => {
            if (m.type === 'v2/ticker' && m.symbol === symbol) {
              clearTimeout(timeout)
              sock.stop()
              resolve(this.now() - start)
            }
          },
          onState: () => {}
        },
        factory
      )
      sock.setSubscription('v2/ticker', [symbol])
      sock.start()
    })
  }
}
