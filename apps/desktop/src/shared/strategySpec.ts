import type { StrategyRisk, StrategyType, Timeframe } from './ipc'

/** [min, max, default]. Mirrors engine/tradepilot_engine/strategies.py; the engine re-validates before every backtest. */
export const STRATEGY_PARAMS: Record<StrategyType, Record<string, [number, number, number]>> = {
  sma_cross: { fast: [2, 200, 10], slow: [3, 400, 30] },
  ema_cross: { fast: [2, 200, 12], slow: [3, 400, 26] },
  rsi_reversion: { period: [2, 100, 14], oversold: [5, 50, 30], overbought: [50, 95, 70] },
  breakout: { lookback: [5, 200, 20] }
}

export const RISK_LIMITS: Record<keyof StrategyRisk, [number, number, number]> = {
  positionPct: [1, 100, 10],
  stopLossPct: [0, 50, 2],
  takeProfitPct: [0, 200, 4],
  feeBps: [0, 100, 5]
}

export const TIMEFRAMES: Timeframe[] = ['5m', '15m', '1h', '4h', '1d']

export const PARAM_LABELS: Record<string, string> = {
  fast: 'Fast period',
  slow: 'Slow period',
  period: 'RSI period',
  oversold: 'Oversold level',
  overbought: 'Overbought level',
  lookback: 'Channel lookback'
}

export const STRATEGY_DESCRIPTIONS: Record<StrategyType, string> = {
  sma_cross: 'Long while the fast simple moving average is above the slow one.',
  ema_cross: 'Long while the fast exponential moving average is above the slow one.',
  rsi_reversion: 'Buys when RSI drops below the oversold level and exits as it recovers to 50.',
  breakout: 'Enters when price closes beyond the highest high of the lookback window.'
}

/** Maximum backtest lookback in days per timeframe (bounded by exchange history limits). */
export const MAX_BACKTEST_DAYS: Record<Timeframe, number> = { '5m': 14, '15m': 45, '1h': 180, '4h': 365, '1d': 1500 }
