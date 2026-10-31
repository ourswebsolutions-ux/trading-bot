import { UserError } from '../errors.js'
import { ProviderError } from '../net.js'
import { findGaps, TF_SECONDS } from '../marketData.js'
import { MAX_BACKTEST_DAYS } from '../../shared/strategySpec.js'
import type { Candle, CandleSeries, DataState, Instrument, LiveCandle, MarketHealth, MarketSnapshot, Quote, Ticker, Timeframe } from '../../shared/ipc.js'
import type { MarketProvider } from '../brokers/types.js'
import type { Mt5Rate, Mt5Symbol, Mt5Tick } from './client.js'
import type { Mt5Connection } from './connection.js'

const INSTRUMENTS_TTL_MS = 10 * 60_000
const POLL_MS = 1_000
const CANDLE_EVERY_POLLS = 5
const RETRY_MS = 5_000
const MAX_BARS = 20_000
/** No tick for this long (UTC), on a weekend or after a long silence, means the market is closed. */
const CLOSED_AFTER_SEC = 180
const LONG_SILENCE_SEC = 30 * 60
/** Ticks sampled (one per second) to learn the broker's clock when nothing else is polling. */
const CLOCK_SAMPLES = 6

export interface Mt5MarketDeps {
  conn: Mt5Connection
  settings: () => { staleAfterSec: number }
  onSnapshot: (s: MarketSnapshot) => void
  onCandle: (c: LiveCandle) => void
  now?: () => number
  log?: (msg: string) => void
  /** Tests: a fake clock advances instead of waiting. */
  sleep?: (ms: number) => Promise<void>
}

/** Weekend in forex terms: Friday 21:00 UTC to Sunday 21:00 UTC (approximate; sessions vary by broker). */
export function isForexWeekend(ms: number): boolean {
  const d = new Date(ms)
  const day = d.getUTCDay()
  const h = d.getUTCHours()
  return day === 6 || (day === 5 && h >= 21) || (day === 0 && h < 21)
}

/** Pip size: 10 points on 3- and 5-digit quotes (EURUSD 0.0001, USDJPY 0.01), otherwise one point. */
export function pipSizeOf(digits: number, point: number): number {
  return digits === 3 || digits === 5 ? Number((point * 10).toPrecision(12)) : point
}

/** Maps an MT5 symbol to a broker-neutral instrument (sizing in lots; see shared/sizing.ts). */
export function toInstrument(s: Mt5Symbol): Instrument {
  const tickValue = s.trade_tick_value
  const tickSize = s.trade_tick_size || s.point
  // tick value is maintained only for symbols in Market Watch; without it sizing is impossible
  // rounded to 12 significant digits: 1 / 0.00001 must be 100000, not 99999.99999999999
  const valuePerPoint = tickValue > 0 && tickSize > 0 ? Number((tickValue / tickSize).toPrecision(12)) : null
  return {
    symbol: s.name,
    productId: 0,
    settlingAsset: s.currency_profit || null,
    description: s.description || s.name,
    underlying: s.currency_base || null,
    quoteAsset: s.currency_profit || null,
    tickSize,
    contractValue: null,
    tradingStatus: String(s.trade_mode),
    venue: 'mt5',
    digits: s.digits,
    pipSize: pipSizeOf(s.digits, s.point),
    assetClass: (s.path || '').split(/[\\/]/)[0]?.toLowerCase() || null,
    minStopDistance: s.trade_stops_level > 0 ? s.trade_stops_level * s.point : 0,
    contractSize: s.trade_contract_size || null,
    valuePerPoint,
    // fixed-quantity strategies on MT5 are expressed in lots
    unitsPerVolume: 1,
    volumeStep: s.volume_step,
    volumeMin: s.volume_min,
    volumeMax: s.volume_max > 0 ? s.volume_max : null,
    volumeUnit: 'lots'
  }
}

interface QuoteState {
  quote: Quote
  /** Tick time in UTC (ms). */
  tickUtcMs: number
}

/**
 * MetaTrader 5 market data through the local terminal. MT5 has no streaming API for Python, so
 * watched symbols are polled every second. Every quote carries its freshness, including
 * "closed" when the market session is over, so nothing old is shown as live.
 */
export class Mt5MarketData implements MarketProvider {
  readonly broker = 'mt5' as const
  private quotes = new Map<string, QuoteState>()
  private watchers = new Map<string, Set<string>>()
  private charts = new Map<string, { symbol: string; timeframe: Timeframe }>()
  private instrumentsCache: { at: number; list: Instrument[]; points: Map<string, number> } | null = null
  private instrumentsLoading: Promise<Instrument[]> | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private polls = 0
  private lastPollAt: number | null = null
  private lastError: string | null = null
  private epoch = 0
  private wasConnected = false
  private readonly now: () => number

  constructor(private readonly d: Mt5MarketDeps) {
    this.now = d.now ?? (() => Date.now())
  }

  start(): void {}

  stop(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  applySettings(): void {
    this.instrumentsCache = null
    this.quotes.clear()
    this.lastError = null
  }

  // ---------- instruments ----------
  async instruments(force = false): Promise<Instrument[]> {
    if (!force && this.instrumentsCache && this.now() - this.instrumentsCache.at < INSTRUMENTS_TTL_MS) return this.instrumentsCache.list
    this.instrumentsLoading ??= this.d.conn
      .read((c) => c.symbols())
      .then((rows) => {
        // disabled symbols (trade_mode 0) cannot be traded at all
        const usable = rows.filter((r) => r.trade_mode !== 0)
        const list = usable.map(toInstrument).sort((a, b) => a.symbol.localeCompare(b.symbol))
        this.instrumentsCache = { at: this.now(), list, points: new Map(usable.map((r) => [r.name, r.point])) }
        this.lastError = null
        return list
      })
      .catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err)
        throw err
      })
      .finally(() => (this.instrumentsLoading = null))
    return this.instrumentsLoading
  }

  /** Fresh spec (selects the symbol so its tick value is current). */
  async instrument(symbol: string): Promise<Instrument> {
    const info = await this.d.conn.read((c) => c.symbolInfo(symbol))
    return toInstrument(info)
  }

  isSupported(symbol: string): boolean | null {
    return this.instrumentsCache ? this.instrumentsCache.list.some((i) => i.symbol === symbol) : null
  }

  async requireSupported(symbol: string): Promise<void> {
    if (!/^[A-Za-z0-9._#+!-]{1,32}$/.test(symbol)) throw new UserError('validation_failed', 'Invalid symbol')
    const list = await this.instruments()
    if (!list.some((i) => i.symbol === symbol)) throw new UserError('unsupported_symbol', `${symbol} is not offered by your MetaTrader 5 broker. Symbol names are broker-specific (for example EURUSD, EURUSD.m or EURUSD#).`)
  }

  // ---------- quotes ----------
  private watchedSymbols(): Set<string> {
    const out = new Set<string>()
    for (const set of this.watchers.values()) for (const s of set) out.add(s)
    for (const c of this.charts.values()) out.add(c.symbol)
    return out
  }

  watch(viewId: string, symbols: string[], chart?: { symbol: string; timeframe: Timeframe } | null): MarketSnapshot {
    this.watchers.set(viewId, new Set(symbols.slice(0, 50)))
    if (chart) this.charts.set(viewId, chart)
    else this.charts.delete(viewId)
    this.schedule(0)
    return this.snapshot()
  }

  unwatch(viewId: string): void {
    this.watchers.delete(viewId)
    this.charts.delete(viewId)
    if (this.watchedSymbols().size === 0) this.stop()
  }

  private schedule(ms: number) {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.watchedSymbols().size === 0) return
    this.pollTimer = setTimeout(() => void this.poll(), ms)
    this.pollTimer.unref?.()
  }

  private ingest(symbol: string, t: Mt5Tick): void {
    this.d.conn.noteTick(t)
    const tickUtcMs = this.d.conn.toUtc(t.time_msc / 1000) * 1000
    const mid = t.bid > 0 && t.ask > 0 ? (t.bid + t.ask) / 2 : t.bid || t.ask || t.last || null
    const quote: Quote = {
      symbol,
      lastPrice: mid,
      markPrice: mid,
      bid: t.bid || null,
      ask: t.ask || null,
      change24hPct: null,
      high24h: null,
      low24h: null,
      volume24hUsd: null,
      fundingRate: null,
      exchangeTime: new Date(tickUtcMs).toISOString(),
      receivedAt: new Date(this.now()).toISOString(),
      source: 'rest',
      state: 'live'
    }
    this.quotes.set(symbol, { quote, tickUtcMs })
  }

  private classify(q: QuoteState | undefined): DataState {
    if (!q) return 'unavailable'
    if (!this.d.conn.isConnected()) return 'stale'
    const ageSec = (this.now() - q.tickUtcMs) / 1000
    if (ageSec <= Math.max(this.d.settings().staleAfterSec, 5)) return 'live'
    if (ageSec > CLOSED_AFTER_SEC && (isForexWeekend(this.now()) || ageSec > LONG_SILENCE_SEC)) return 'closed'
    return 'stale'
  }

  private async poll(): Promise<void> {
    this.pollTimer = null
    const symbols = [...this.watchedSymbols()]
    if (!symbols.length) return
    try {
      const ticks = await this.d.conn.read((c) => c.ticks(symbols))
      if (!this.wasConnected) this.epoch++
      this.wasConnected = true
      for (const s of symbols) {
        const t = ticks[s]
        if (t) this.ingest(s, t)
      }
      if (this.polls++ % CANDLE_EVERY_POLLS === 0) await this.emitFormingCandles()
      this.lastPollAt = this.now()
      this.lastError = null
      this.d.onSnapshot(this.snapshot())
      this.schedule(POLL_MS)
    } catch (err) {
      this.wasConnected = false
      this.lastError = err instanceof Error ? err.message : String(err)
      this.d.onSnapshot(this.snapshot())
      this.schedule(RETRY_MS)
    }
  }

  private async emitFormingCandles(): Promise<void> {
    for (const c of new Map([...this.charts.values()].map((x) => [`${x.symbol}:${x.timeframe}`, x])).values()) {
      const rows = await this.d.conn.read((cl) => cl.rates(c.symbol, c.timeframe, 1)).catch(() => [])
      const r = rows.at(-1)
      if (r) this.d.onCandle({ symbol: c.symbol, timeframe: c.timeframe, candle: this.toCandle(r, this.instrumentsCache?.points.get(c.symbol)), receivedAt: new Date(this.now()).toISOString() })
    }
  }

  private async tick(symbol: string): Promise<Mt5Tick> {
    const t = (await this.d.conn.read((c) => c.ticks([symbol])))[symbol]
    if (!t || !(t.bid > 0) || !(t.ask > 0)) throw new UserError('no_price', `MetaTrader 5 has no current price for ${symbol}. The market may be closed or the symbol is not in Market Watch.`)
    this.ingest(symbol, t)
    return t
  }

  async markPrice(symbol: string): Promise<number> {
    const t = await this.tick(symbol)
    return (t.bid + t.ask) / 2
  }

  async quote(symbol: string): Promise<{ bid: number; ask: number }> {
    const t = await this.tick(symbol)
    return { bid: t.bid, ask: t.ask }
  }

  /**
   * False only when the session is over (no ticks, or no price at all for the symbol). A broken
   * terminal connection is an error, not a closed market: automation must report it, not skip quietly.
   */
  async isMarketOpen(symbol: string): Promise<boolean> {
    try {
      await this.tick(symbol)
    } catch (err) {
      if (err instanceof UserError && err.code === 'no_price') return false
      throw err
    }
    return this.classify(this.quotes.get(symbol)) !== 'closed'
  }

  async tickers(symbols?: string[]): Promise<Ticker[]> {
    const wanted = symbols?.length ? symbols : [...this.watchedSymbols()].slice(0, 12)
    if (!wanted.length) return []
    const ticks = await this.d.conn.read((c) => c.ticks(wanted))
    const out: Ticker[] = []
    for (const s of wanted) {
      const t = ticks[s]
      if (!t || !(t.bid > 0)) continue
      this.ingest(s, t)
      const mid = (t.bid + t.ask) / 2
      out.push({ symbol: s, description: s, markPrice: mid, lastPrice: mid, change24hPct: null, high24h: null, low24h: null, volume24hUsd: null, fundingRate: null, updatedAt: new Date(this.d.conn.toUtc(t.time_msc / 1000) * 1000).toISOString() })
    }
    return out
  }

  // ---------- candles ----------
  private toCandle(r: Mt5Rate, point: number | undefined): Candle {
    const c: Candle = { time: this.d.conn.toUtc(r.time), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.tick_volume }
    if (point && r.spread > 0) c.spread = Number((r.spread * point).toPrecision(12))
    return c
  }

  /**
   * Samples a few ticks a second apart when the broker's clock is unknown (fresh install, or a new
   * trade server), so automation does not depend on a chart being open. Learns only from a market
   * that is moving; a closed market leaves the offset unknown.
   */
  async learnClock(symbol: string): Promise<number | null> {
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    for (let i = 0; i < CLOCK_SAMPLES && this.d.conn.serverOffset() === null; i++) {
      if (i > 0) await sleep(1000)
      await this.tick(symbol).catch(() => undefined)
    }
    return this.d.conn.serverOffset()
  }

  /**
   * @param requireClock automation needs exact candle times: refuse until the broker's server
   * time offset is known (learned within seconds of live ticks; remembered across restarts).
   */
  async series(symbol: string, timeframe: Timeframe, days: number, requireClock = false): Promise<CandleSeries> {
    await this.requireSupported(symbol)
    const step = TF_SECONDS[timeframe]
    const span = Math.max(1, Math.min(days, MAX_BACKTEST_DAYS[timeframe])) * 86400
    const count = Math.min(MAX_BARS, Math.ceil(span / step) + 1)
    if (requireClock) await this.learnClock(symbol)
    if (this.d.conn.serverOffset() === null) {
      if (requireClock) throw new UserError('mt5_clock_unknown', 'Waiting for live MetaTrader 5 prices to determine the broker\'s server time; candles cannot be aligned yet.')
      this.d.log?.('mt5: broker time offset not learned yet (no moving ticks); candle times assume UTC')
    }
    const rows = await this.d.conn.read((c) => c.rates(symbol, timeframe, count))
    const point = this.instrumentsCache?.points.get(symbol)
    const nowSec = this.now() / 1000
    // the newest bar is still forming: candles are closed bars only
    const candles = rows.map((r) => this.toCandle(r, point)).filter((c) => c.time + step <= nowSec && c.time >= nowSec - span - step)
    const gaps = findGaps(candles, step)
    return { symbol, timeframe, candles, gaps, missing: gaps.reduce((a, g) => a + g.missing, 0), fetchedAt: new Date(this.now()).toISOString(), source: 'historical' }
  }

  async candles(symbol: string, timeframe: Timeframe, days: number, requireClock = false): Promise<Candle[]> {
    return (await this.series(symbol, timeframe, days, requireClock)).candles
  }

  // ---------- status ----------
  health(): MarketHealth {
    const acct = this.d.conn.cachedAccount()
    return {
      broker: 'mt5',
      region: 'mt5',
      regionLabel: acct ? `MetaTrader 5 · ${acct.server}` : 'MetaTrader 5',
      transport: this.d.conn.isConnected() && !this.lastError ? 'rest' : 'offline',
      socket: 'disabled',
      connectionEpoch: this.epoch,
      lastMessageAt: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : null,
      lastRestAt: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : null,
      reconnects: 0,
      lastError: this.lastError ?? this.d.conn.unavailable() ?? this.d.conn.lastError,
      instruments: this.instrumentsCache?.list.length ?? 0,
      instrumentsAt: this.instrumentsCache ? new Date(this.instrumentsCache.at).toISOString() : null,
      staleAfterMs: this.d.settings().staleAfterSec * 1000,
      unsupported: [],
      duplicatesIgnored: 0
    }
  }

  snapshot(): MarketSnapshot {
    const quotes: Record<string, Quote> = {}
    for (const sym of this.watchedSymbols()) {
      const q = this.quotes.get(sym)
      if (q) quotes[sym] = { ...q.quote, state: this.classify(q) }
    }
    return { health: this.health(), quotes, at: new Date(this.now()).toISOString() }
  }

  async test(symbol: string): Promise<string> {
    const why = this.d.conn.unavailable()
    if (why) throw new ProviderError('provider', why)
    const t0 = this.now()
    const list = await this.instruments(true)
    const sym = list.some((i) => i.symbol === symbol) ? symbol : list.find((i) => /^EURUSD/.test(i.symbol))?.symbol ?? list[0]?.symbol
    if (!sym) throw new ProviderError('provider', 'The MetaTrader 5 terminal returned no tradable symbols.')
    const t = await this.tick(sym)
    const offset = await this.learnClock(sym)
    return [
      `${list.length} symbols in ${this.now() - t0} ms`,
      `${sym} bid ${t.bid} / ask ${t.ask}`,
      offset === null ? 'broker time offset not known yet (market closed?)' : `broker server time UTC${offset >= 0 ? '+' : '-'}${Math.abs(offset) / 3600}h`
    ].join(' · ')
  }
}
