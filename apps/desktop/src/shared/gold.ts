/**
 * XAUUSD (gold vs US dollar) workflow: broker symbol detection, the Gold Bot settings and the
 * built-in strategy they generate. Pure TypeScript shared by the main process and the renderer.
 *
 * The strategy is an ordinary rule-based definition (see strategyRules.ts), so it is validated,
 * backtested and automated by the same engine as every other strategy. Nothing here predicts
 * prices or guarantees results.
 */
import type { Instrument, Timeframe } from './ipc'
import type { Condition, IndicatorDef, Operand, RuleGroup, StrategyDefinition } from './strategyRules'

// ---------- symbol detection ----------
export interface GoldCandidate {
  symbol: string
  score: number
  /** Why this symbol was chosen (shown in the UI). */
  reasons: string[]
}

type SymbolInfo = Pick<Instrument, 'symbol' | 'description'> & Partial<Pick<Instrument, 'underlying' | 'quoteAsset' | 'assetClass' | 'tradingStatus'>>

const OTHER_QUOTE = /^(XAU|GOLD)(EUR|AUD|GBP|JPY|CHF|CNH|SGD|TRY|THB|INR|CAD|HKD)/i
const FUTURES = /(^GC[A-Z]?\d|_F\b|\.F$|FUT|[FGHJKMNQUVXZ]\d{2}$|\d{4})/i
const MINI = /(MINI|MICRO)/i

/**
 * Ranks the broker's symbols that quote spot gold in US dollars: XAUUSD, XAUUSDm, XAUUSD.r,
 * XAUUSD#, GOLD, GOLDm, … Gold in other currencies (XAUEUR, GOLDEUR), futures and silver are
 * excluded. Symbol names differ between brokers, so nothing is assumed: an empty list means the
 * broker offers no recognisable spot gold symbol and the user must pick one.
 */
export function detectGoldSymbols(symbols: SymbolInfo[]): GoldCandidate[] {
  const out: GoldCandidate[] = []
  for (const s of symbols) {
    const name = s.symbol
    const upper = name.toUpperCase()
    const base = (s.underlying ?? '').toUpperCase()
    const quote = (s.quoteAsset ?? '').toUpperCase()
    const desc = (s.description ?? '').toLowerCase()
    const byCurrencies = base === 'XAU' && quote === 'USD'
    const byName = /^XAUUSD/.test(upper) || /^GOLD/.test(upper)
    if (!byCurrencies && !byName) continue
    if (OTHER_QUOTE.test(upper) && !/^(XAU|GOLD)USD/.test(upper)) continue
    if (quote && quote !== 'USD') continue
    if (base && base !== 'XAU' && !/^GOLD/.test(upper)) continue
    if (s.tradingStatus === '0') continue // disabled at the broker
    const reasons: string[] = []
    let score = 0
    if (byCurrencies) {
      score += 100
      reasons.push('base currency XAU, profit currency USD')
    }
    if (/^XAUUSD/.test(upper)) {
      score += 60
      if (upper === 'XAUUSD') score += 20
      reasons.push('named XAUUSD')
    } else if (/^GOLD/.test(upper)) {
      score += 50
      if (upper === 'GOLD') score += 10
      reasons.push('named GOLD')
    }
    if (desc.includes('gold')) {
      score += 20
      reasons.push(`described as "${s.description}"`)
    }
    if ((s.assetClass ?? '').includes('metal')) score += 10
    if (s.tradingStatus === '3') {
      score -= 80
      reasons.push('close-only at this broker')
    } else if (s.tradingStatus === '1' || s.tradingStatus === '2') {
      score -= 40
      reasons.push('only one direction is allowed at this broker')
    }
    if (FUTURES.test(upper.replace(/^XAUUSD|^GOLD/, ''))) {
      score -= 60
      reasons.push('looks like a futures contract')
    }
    if (MINI.test(upper)) {
      score -= 15
      reasons.push('mini/micro contract')
    }
    out.push({ symbol: name, score, reasons })
  }
  return out.sort((a, b) => b.score - a.score || a.symbol.length - b.symbol.length || a.symbol.localeCompare(b.symbol))
}

export function isGoldSymbol(s: SymbolInfo): boolean {
  return detectGoldSymbols([s]).length > 0
}

// ---------- settings ----------
export type GoldAccountMode = 'demo' | 'live'
export type ScalpEntryStyle = 'pullback' | 'breakout' | 'momentum'

/**
 * XAUUSD scalping settings. Entries on M1 or M5 candles; the short-term trend comes from a higher
 * timeframe (M15 by default). Defaults are deliberately conservative for demo testing.
 */
export interface GoldSettings {
  /** Broker symbol; null = use the detected one. */
  symbol: string | null
  /** Demo: orders only on a demo account. Live: only on a real-money account (explicitly confirmed). */
  accountMode: GoldAccountMode
  /** Entry timing timeframe. */
  timeframe: '1m' | '5m'
  /** Trend confirmation timeframe (completed candles only). */
  trendTimeframe: '15m' | '30m' | '1h'
  direction: 'long' | 'short' | 'both'
  /** pullback: a dip to EMA 20 that closes back above EMA 9 · breakout: close beyond the last 10 candles · momentum: MACD cross */
  entryStyle: ScalpEntryStyle
  useTrendFilter: boolean
  useRsi: boolean
  useMacd: boolean
  /** VWAP from MT5 tick volume (the number of price changes; no traded volume exists for spot gold). */
  useVwap: boolean
  /** The signal candle must close in the trade's direction. */
  useCandleConfirmation: boolean
  lotMode: 'risk' | 'fixed'
  /** Percent of equity lost if the stop-loss is hit (lotMode "risk"). */
  riskPercent: number
  /** Lots per trade (lotMode "fixed"). */
  fixedLots: number
  /** Stop-loss distance as a multiple of ATR(14) of the entry timeframe. */
  stopAtr: number
  /** Take-profit as a multiple of the stop distance (reward : risk). */
  takeProfitR: number
  /** The take-profit may not be set below this reward : risk. */
  minRiskReward: number
  maxDailyLossPct: number
  maxTradesPerDay: number
  maxConsecutiveLosses: number
  /** Minutes to wait after a trade closes. */
  cooldownMinutes: number
  /** A position is closed at market after this many minutes. */
  maxTradeMinutes: number
  /** Largest spread allowed for a new trade, in US dollars per ounce (e.g. 0.40). */
  maxSpread: number
  /** No entry when price is more than this many ATR away from EMA 20 (chasing an extended move). */
  maxExtensionAtr: number
  /** No entry after a candle larger than this many ATR (a spike, e.g. on news). */
  abnormalRangeAtr: number
  /** UTC trading window, or null for all hours the market is open. */
  session: { start: string; end: string } | null
  /** High-risk periods you enter yourself (e.g. scheduled US data releases). TradePilot has no news feed. */
  events: { start: string; end: string; label: string }[]
  /** Broker commission per lot and side, used by backtests only. */
  commissionPerLot: number
}

export const GOLD_TF_LABEL: Record<Timeframe, string> = { '1m': 'M1', '5m': 'M5', '15m': 'M15', '30m': 'M30', '1h': 'H1', '4h': 'H4', '1d': 'D1' }
const TF_MIN: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60 }

export const DEFAULT_GOLD_SETTINGS: GoldSettings = {
  symbol: null,
  accountMode: 'demo',
  timeframe: '5m',
  trendTimeframe: '15m',
  direction: 'both',
  entryStyle: 'pullback',
  useTrendFilter: true,
  useRsi: true,
  useMacd: true,
  useVwap: false,
  useCandleConfirmation: true,
  lotMode: 'risk',
  riskPercent: 0.25,
  fixedLots: 0.01,
  stopAtr: 1.2,
  takeProfitR: 1.5,
  minRiskReward: 1.2,
  maxDailyLossPct: 2,
  maxTradesPerDay: 8,
  maxConsecutiveLosses: 3,
  cooldownMinutes: 10,
  maxTradeMinutes: 60,
  maxSpread: 0.4,
  maxExtensionAtr: 1.5,
  abnormalRangeAtr: 3,
  session: { start: '07:00', end: '20:00' },
  events: [],
  commissionPerLot: 0
}

export const GOLD_LIMITS = {
  riskPercent: [0.01, 2] as [number, number],
  fixedLots: [0.01, 100] as [number, number],
  stopAtr: [0.3, 5] as [number, number],
  takeProfitR: [0.5, 10] as [number, number],
  minRiskReward: [0.5, 10] as [number, number],
  maxDailyLossPct: [0.1, 20] as [number, number],
  maxTradesPerDay: [1, 100] as [number, number],
  maxConsecutiveLosses: [1, 20] as [number, number],
  cooldownMinutes: [0, 600] as [number, number],
  maxTradeMinutes: [1, 1440] as [number, number],
  maxSpread: [0.01, 50] as [number, number],
  maxExtensionAtr: [0.3, 10] as [number, number],
  abnormalRangeAtr: [1, 20] as [number, number],
  commissionPerLot: [0, 100] as [number, number]
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const within = (v: unknown, [lo, hi]: [number, number]) => num(v) && v >= lo && v <= hi

/** Field errors for user-entered settings (empty = valid). */
export function validateGoldSettings(s: GoldSettings): Record<string, string> {
  const e: Record<string, string> = {}
  if (s.symbol !== null && !/^[A-Za-z0-9._#+!-]{1,32}$/.test(s.symbol)) e.symbol = 'Choose the gold symbol from your broker’s list.'
  if (s.timeframe !== '1m' && s.timeframe !== '5m') e.timeframe = 'Scalping entries use M1 or M5.'
  if (!['15m', '30m', '1h'].includes(s.trendTimeframe)) e.trendTimeframe = 'Choose M15, M30 or H1 for the trend.'
  if (!['long', 'short', 'both'].includes(s.direction)) e.direction = 'Choose BUY only, SELL only or both.'
  if (!['pullback', 'breakout', 'momentum'].includes(s.entryStyle)) e.entryStyle = 'Choose an entry style.'
  if (s.accountMode !== 'demo' && s.accountMode !== 'live') e.accountMode = 'Choose demo or live.'
  if (s.lotMode !== 'risk' && s.lotMode !== 'fixed') e.lotMode = 'Choose how lots are calculated.'
  for (const k of Object.keys(GOLD_LIMITS) as (keyof typeof GOLD_LIMITS)[]) {
    if (!within(s[k], GOLD_LIMITS[k])) e[k] = `Enter a value from ${GOLD_LIMITS[k][0]} to ${GOLD_LIMITS[k][1]}.`
  }
  for (const k of ['maxTradesPerDay', 'maxConsecutiveLosses', 'cooldownMinutes', 'maxTradeMinutes'] as const) if (num(s[k]) && !Number.isInteger(s[k])) e[k] = 'Enter a whole number.'
  if (num(s.takeProfitR) && num(s.minRiskReward) && s.takeProfitR < s.minRiskReward) e.takeProfitR = `The take-profit (${s.takeProfitR}R) is below your minimum reward : risk of ${s.minRiskReward}.`
  if (s.lotMode === 'risk' && num(s.riskPercent) && num(s.maxDailyLossPct) && s.riskPercent > s.maxDailyLossPct) {
    e.riskPercent = 'One losing trade would exceed the daily loss limit. Lower the risk per trade or raise the limit.'
  }
  if (s.session !== null) {
    if (!HHMM.test(s.session?.start ?? '') || !HHMM.test(s.session?.end ?? '')) e.session = 'Use HH:MM in UTC, for example 07:00 and 20:00.'
    else if (s.session.start === s.session.end) e.session = 'Start and end must differ.'
  }
  if (!Array.isArray(s.events) || s.events.length > 200) e.events = 'At most 200 events.'
  else s.events.forEach((ev) => {
    const a = Date.parse(ev?.start ?? '')
    const b = Date.parse(ev?.end ?? '')
    if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b) e.events = 'Each event needs a start before its end (UTC).'
    else if (!ev.label?.trim() || ev.label.length > 80) e.events = 'Give each event a short name.'
  })
  return e
}

const bars = (minutes: number, tf: string) => Math.max(1, Math.ceil(minutes / TF_MIN[tf]!))

// ---------- the built-in scalping strategy ----------
export const GOLD_STRATEGY_NAME = 'XAUUSD Gold Scalper'

/**
 * Short-term gold scalping, decided on closed candles of the entry timeframe (M1/M5):
 *  - trend: EMA 20 above EMA 50 on completed M15 candles (mirror for sells)
 *  - momentum stack on the entry timeframe: EMA 9 above EMA 20 above EMA 50
 *  - entry trigger, by style: a pullback that touched EMA 20 and closed back above EMA 9, a close
 *    above the previous 10 candles' high, or the MACD line crossing above its signal line
 *  - confirmations (each optional): RSI(14) between 50 and 70 (30–50 for sells), MACD above its
 *    signal line, close above the daily VWAP, a candle closing in the trade's direction
 *  - filters: spread, session, extended moves, abnormal candles, configured high-risk events
 *  - exits: ATR stop-loss, take-profit at a reward : risk multiple, EMA 9 crossing back under
 *    EMA 20, or the maximum trade duration
 * No single indicator opens a trade. Nothing here predicts prices or guarantees results.
 */
export function goldDefinition(s: GoldSettings, symbol: string): StrategyDefinition {
  const ind = (id: string, kind: IndicatorDef['kind'], period: number, extra: Partial<IndicatorDef> = {}): IndicatorDef => ({ id, kind, period, ...extra })
  const I = (id: string): Operand => ({ type: 'indicator', id })
  const P = (field: 'open' | 'high' | 'low' | 'close'): Operand => ({ type: 'price', field })
  const V = (value: number): Operand => ({ type: 'value', value })
  const c = (left: Operand, op: Condition['op'], right: Operand): Condition => ({ left, op, right })
  const macdUsed = s.useMacd || s.entryStyle === 'momentum'
  const indicators: IndicatorDef[] = [ind('ema_9', 'ema', 9), ind('ema_20', 'ema', 20), ind('ema_50', 'ema', 50)]
  if (s.useTrendFilter) indicators.push(ind('trend_ema_20', 'ema', 20, { timeframe: s.trendTimeframe }), ind('trend_ema_50', 'ema', 50, { timeframe: s.trendTimeframe }))
  if (s.useRsi) indicators.push(ind('rsi_14', 'rsi', 14))
  if (macdUsed) indicators.push(ind('macd', 'macd_line', 12, { slow: 26, signal: 9 }), ind('macd_signal', 'macd_signal', 12, { slow: 26, signal: 9 }))
  if (s.entryStyle === 'breakout') indicators.push(ind('high_10', 'highest_high', 10), ind('low_10', 'lowest_low', 10))
  if (s.useVwap) indicators.push(ind('vwap', 'vwap', 1))

  const side = (dir: 1 | -1): RuleGroup => {
    const up = dir === 1
    const above = up ? '>' : '<'
    const conds: Condition[] = []
    if (s.useTrendFilter) conds.push(c(I('trend_ema_20'), above, I('trend_ema_50')))
    conds.push(c(I('ema_9'), above, I('ema_20')), c(I('ema_20'), above, I('ema_50')))
    if (s.entryStyle === 'pullback') conds.push(c(P(up ? 'low' : 'high'), up ? '<=' : '>=', I('ema_20')), c(P('close'), above, I('ema_9')))
    else if (s.entryStyle === 'breakout') conds.push(c(P('close'), up ? 'crosses_above' : 'crosses_below', I(up ? 'high_10' : 'low_10')))
    else conds.push(c(I('macd'), up ? 'crosses_above' : 'crosses_below', I('macd_signal')))
    if (s.useRsi) conds.push(c(I('rsi_14'), up ? '>' : '<', V(50)), c(I('rsi_14'), up ? '<' : '>', V(up ? 70 : 30)))
    if (s.useMacd && s.entryStyle !== 'momentum') conds.push(c(I('macd'), above, I('macd_signal')))
    if (s.useVwap) conds.push(c(P('close'), above, I('vwap')))
    if (s.useCandleConfirmation) conds.push(c(P('close'), above, P('open')))
    return { match: 'all', conditions: conds }
  }
  const long = s.direction !== 'short'
  const short = s.direction !== 'long'
  const tf = GOLD_TF_LABEL[s.timeframe]
  return {
    version: 2,
    venue: 'mt5',
    name: GOLD_STRATEGY_NAME,
    description: `Built-in XAUUSD scalper on ${tf} (${s.entryStyle} entries${s.useTrendFilter ? `, ${GOLD_TF_LABEL[s.trendTimeframe]} trend` : ''}); ATR(14) × ${s.stopAtr} stop-loss, ${s.takeProfitR}R take-profit, at most ${s.maxTradeMinutes} minutes per trade. Edit it on the Gold Scalper page.`,
    symbol,
    timeframe: s.timeframe,
    direction: s.direction,
    indicators,
    entry: { long: long ? side(1) : null, short: short ? side(-1) : null },
    exit: {
      long: long ? { match: 'all', conditions: [c(I('ema_9'), 'crosses_below', I('ema_20'))] } : null,
      short: short ? { match: 'all', conditions: [c(I('ema_9'), 'crosses_above', I('ema_20'))] } : null
    },
    risk: {
      stopLoss: { type: 'atr', value: s.stopAtr },
      takeProfit: { type: 'risk_multiple', value: s.takeProfitR },
      sizing: s.lotMode === 'fixed' ? { type: 'fixed_quantity', value: s.fixedLots } : { type: 'risk_percent', value: s.riskPercent },
      maxDailyLossPct: s.maxDailyLossPct,
      maxDailyLossUsd: null,
      maxTradesPerDay: s.maxTradesPerDay,
      allocatedCapitalUsd: null,
      feeBps: 0,
      maxConsecutiveLosses: s.maxConsecutiveLosses,
      cooldownBars: s.cooldownMinutes > 0 ? bars(s.cooldownMinutes, s.timeframe) : 0,
      maxTradeBars: bars(s.maxTradeMinutes, s.timeframe)
    },
    filters: {
      maxSpread: s.maxSpread,
      session: s.session,
      maxExtensionAtr: s.maxExtensionAtr,
      abnormalRangeAtr: s.abnormalRangeAtr,
      events: s.events.length ? s.events : null
    }
  }
}

/** Reads stored settings defensively: unknown or missing fields fall back to the defaults. */
export function normalizeGoldSettings(raw: unknown): GoldSettings {
  const o = raw && typeof raw === 'object' ? (raw as Partial<GoldSettings>) : {}
  const merged = { ...DEFAULT_GOLD_SETTINGS, ...o, session: o.session === undefined ? DEFAULT_GOLD_SETTINGS.session : o.session, events: Array.isArray(o.events) ? o.events : [] }
  // settings saved by the earlier swing version: entries now use M1/M5
  if (merged.timeframe !== '1m' && merged.timeframe !== '5m') merged.timeframe = DEFAULT_GOLD_SETTINGS.timeframe
  return merged
}
