import type { BrokerId, Candle, CandleSeries, Instrument, MarketHealth, MarketSnapshot, Ticker, Timeframe } from '../../shared/ipc.js'

/**
 * Market data from one broker. Delta Exchange (MarketDataService) and MetaTrader 5
 * (Mt5MarketData) both implement it; the app talks to the active one through BrokerMarkets.
 */
export interface MarketProvider {
  readonly broker: BrokerId
  start(): void
  stop(): void
  applySettings(): void
  instruments(force?: boolean): Promise<Instrument[]>
  /** A freshly read spec for one symbol (MT5: tick value changes with prices). */
  instrument?(symbol: string): Promise<Instrument>
  isSupported(symbol: string): boolean | null
  requireSupported(symbol: string): Promise<void>
  watch(viewId: string, symbols: string[], chart?: { symbol: string; timeframe: Timeframe } | null): MarketSnapshot
  unwatch(viewId: string): void
  tickers(symbols?: string[]): Promise<Ticker[]>
  /** Reference price (Delta: mark price; MT5: bid/ask mid). */
  markPrice(symbol: string): Promise<number>
  /** Bid/ask, where the venue has them (paper fills buy at the ask and sell at the bid). */
  quote?(symbol: string): Promise<{ bid: number; ask: number }>
  /** False while the market is closed (weekends, session breaks). Venues that never close omit it. */
  isMarketOpen?(symbol: string): Promise<boolean>
  series(symbol: string, timeframe: Timeframe, days: number): Promise<CandleSeries>
  candles(symbol: string, timeframe: Timeframe, days: number): Promise<Candle[]>
  health(): MarketHealth
  snapshot(): MarketSnapshot
  test(symbol: string): Promise<string>
}
