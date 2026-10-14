import type { Timeframe } from './ipc'
export { TIMEFRAMES } from './strategyRules'

/** Maximum backtest lookback in days per timeframe (bounded by exchange history limits). */
export const MAX_BACKTEST_DAYS: Record<Timeframe, number> = { '5m': 14, '15m': 45, '1h': 180, '4h': 365, '1d': 1500 }
