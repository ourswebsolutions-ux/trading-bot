import type { BrokerId, Candle, CandleSeries, Instrument, MarketHealth, MarketSnapshot, Ticker, Timeframe } from '../../shared/ipc.js'
import type { MarketProvider } from './types.js'

/**
 * The market data the app's screens see: the active broker's. Remembers what each screen
 * watches so a broker switch moves those subscriptions to the new provider.
 * Automation talks to the providers directly (a session trades on its own broker).
 */
export class BrokerMarkets {
  private views = new Map<string, { symbols: string[]; chart: { symbol: string; timeframe: Timeframe } | null }>()
  private current: BrokerId

  constructor(
    private readonly providers: Record<BrokerId, MarketProvider>,
    private readonly active: () => BrokerId
  ) {
    this.current = active()
  }

  get(): MarketProvider {
    const now = this.active()
    if (now !== this.current) this.switchTo(now)
    return this.providers[now]
  }

  for(broker: BrokerId): MarketProvider {
    return this.providers[broker]
  }

  isActive(broker: BrokerId): boolean {
    return this.active() === broker
  }

  private switchTo(next: BrokerId) {
    const old = this.providers[this.current]
    for (const id of this.views.keys()) old.unwatch(id)
    this.current = next
    for (const [id, v] of this.views) this.providers[next].watch(id, v.symbols, v.chart)
  }

  /** Call after the broker preference changed. */
  refresh(): void {
    this.get()
  }

  start(): void {
    for (const p of Object.values(this.providers)) p.start()
  }
  stop(): void {
    for (const p of Object.values(this.providers)) p.stop()
  }

  instruments(force = false): Promise<Instrument[]> {
    return this.get().instruments(force)
  }
  isSupported(symbol: string): boolean | null {
    return this.get().isSupported(symbol)
  }
  requireSupported(symbol: string): Promise<void> {
    return this.get().requireSupported(symbol)
  }
  watch(viewId: string, symbols: string[], chart?: { symbol: string; timeframe: Timeframe } | null): MarketSnapshot {
    this.views.set(viewId, { symbols, chart: chart ?? null })
    return this.get().watch(viewId, symbols, chart)
  }
  unwatch(viewId: string): void {
    this.views.delete(viewId)
    this.get().unwatch(viewId)
  }
  tickers(symbols?: string[]): Promise<Ticker[]> {
    return this.get().tickers(symbols)
  }
  markPrice(symbol: string): Promise<number> {
    return this.get().markPrice(symbol)
  }
  series(symbol: string, timeframe: Timeframe, days: number): Promise<CandleSeries> {
    return this.get().series(symbol, timeframe, days)
  }
  candles(symbol: string, timeframe: Timeframe, days: number): Promise<Candle[]> {
    return this.get().candles(symbol, timeframe, days)
  }
  health(): MarketHealth {
    return this.get().health()
  }
  snapshot(): MarketSnapshot {
    return this.get().snapshot()
  }
}
