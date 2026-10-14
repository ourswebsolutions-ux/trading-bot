/** Account-level risk settings for automated trading (shared by UI and main process). */
export interface TradingRiskSettings {
  configured: boolean
  /** Total open notional across positions, as % of equity. */
  maxExposurePct: number
  maxOpenPositions: number
  /** Account-wide realized loss per UTC day, as % of equity at the start of the day. */
  accountMaxDailyLossPct: number
  /** Largest notional for a single order (USD). */
  maxOrderNotionalUsd: number
  /** Starting equity of the simulated paper account. */
  paperStartingEquity: number
  /** Adverse price movement applied to each simulated paper fill (basis points). */
  paperSlippageBps: number
  /** What the emergency stop does with open positions. */
  emergencyAction: 'close_positions' | 'keep_positions'
}

export const DEFAULT_RISK: TradingRiskSettings = {
  configured: false,
  maxExposurePct: 100,
  maxOpenPositions: 1,
  accountMaxDailyLossPct: 3,
  maxOrderNotionalUsd: 1000,
  paperStartingEquity: 10_000,
  paperSlippageBps: 2,
  emergencyAction: 'close_positions'
}

export const RISK_LIMITS: Record<'maxExposurePct' | 'maxOpenPositions' | 'accountMaxDailyLossPct' | 'maxOrderNotionalUsd' | 'paperStartingEquity' | 'paperSlippageBps', [number, number]> = {
  maxExposurePct: [1, 500],
  maxOpenPositions: [1, 20],
  accountMaxDailyLossPct: [0.1, 50],
  maxOrderNotionalUsd: [1, 10_000_000],
  paperStartingEquity: [100, 100_000_000],
  paperSlippageBps: [0, 100]
}

export function validateRisk(r: Partial<TradingRiskSettings>): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const [k, [lo, hi]] of Object.entries(RISK_LIMITS)) {
    const v = r[k as keyof typeof RISK_LIMITS]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) errors[k] = `Between ${lo.toLocaleString()} and ${hi.toLocaleString()}`
  }
  if (typeof r.maxOpenPositions === 'number' && !Number.isInteger(r.maxOpenPositions)) errors.maxOpenPositions = 'Whole number'
  if (r.emergencyAction !== 'close_positions' && r.emergencyAction !== 'keep_positions') errors.emergencyAction = 'Choose what the emergency stop does'
  return errors
}
