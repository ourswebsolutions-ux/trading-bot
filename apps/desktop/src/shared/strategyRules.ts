/**
 * Rule-based strategy model (version 2). Pure TypeScript shared by the renderer (live
 * validation in the builder) and the main process (authoritative checks before enabling).
 * The Python engine evaluates the same structure (engine/tradepilot_engine/rules.py).
 */
import type { BrokerId, Timeframe } from './ipc'

export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']

export type IndicatorKind = 'sma' | 'ema' | 'rsi' | 'atr' | 'highest_high' | 'lowest_low' | 'bb_upper' | 'bb_middle' | 'bb_lower' | 'macd_line' | 'macd_signal' | 'macd_hist' | 'vwap'

export interface IndicatorSpec {
  label: string
  /** What the value means, for explanations. */
  explain: (i: IndicatorDef) => string
  period: [number, number, number]
  stdDev?: [number, number, number]
  /** MACD: slow EMA and signal periods (`period` is the fast EMA). */
  slow?: [number, number, number]
  signal?: [number, number, number]
  /** Fixed value range (e.g. RSI 0–100), used to reject impossible comparisons. */
  range?: [number, number]
  scale: 'price' | 'oscillator' | 'volatility' | 'momentum'
}

export const INDICATORS: Record<IndicatorKind, IndicatorSpec> = {
  sma: { label: 'Simple moving average', explain: (i) => `${i.period}-candle simple moving average of the close`, period: [2, 400, 20], scale: 'price' },
  ema: { label: 'Exponential moving average', explain: (i) => `${i.period}-candle exponential moving average of the close`, period: [2, 400, 20], scale: 'price' },
  rsi: { label: 'RSI', explain: (i) => `${i.period}-candle RSI (0–100)`, period: [2, 100, 14], range: [0, 100], scale: 'oscillator' },
  atr: { label: 'Average true range', explain: (i) => `${i.period}-candle average true range`, period: [2, 100, 14], scale: 'volatility' },
  highest_high: { label: 'Highest high (previous N)', explain: (i) => `highest high of the previous ${i.period} candles`, period: [2, 400, 20], scale: 'price' },
  lowest_low: { label: 'Lowest low (previous N)', explain: (i) => `lowest low of the previous ${i.period} candles`, period: [2, 400, 20], scale: 'price' },
  bb_upper: { label: 'Bollinger upper band', explain: (i) => `upper Bollinger band (${i.period}, ${i.stdDev ?? 2}σ)`, period: [5, 200, 20], stdDev: [0.5, 4, 2], scale: 'price' },
  bb_middle: { label: 'Bollinger middle band', explain: (i) => `middle Bollinger band (${i.period}-candle SMA)`, period: [5, 200, 20], scale: 'price' },
  bb_lower: { label: 'Bollinger lower band', explain: (i) => `lower Bollinger band (${i.period}, ${i.stdDev ?? 2}σ)`, period: [5, 200, 20], stdDev: [0.5, 4, 2], scale: 'price' },
  macd_line: { label: 'MACD line', explain: (i) => `MACD line (${macdParams(i)})`, period: [2, 100, 12], slow: [3, 200, 26], signal: [2, 50, 9], scale: 'momentum' },
  macd_signal: { label: 'MACD signal line', explain: (i) => `MACD signal line (${macdParams(i)})`, period: [2, 100, 12], slow: [3, 200, 26], signal: [2, 50, 9], scale: 'momentum' },
  macd_hist: { label: 'MACD histogram', explain: (i) => `MACD histogram (${macdParams(i)}; above 0 = rising momentum)`, period: [2, 100, 12], slow: [3, 200, 26], signal: [2, 50, 9], scale: 'momentum' },
  vwap: { label: 'VWAP (daily)', explain: () => 'volume-weighted average price since 00:00 UTC (MetaTrader 5: weighted by tick volume)', period: [1, 1, 1], scale: 'price' }
}

export interface IndicatorDef {
  id: string
  kind: IndicatorKind
  period: number
  stdDev?: number
  /** MACD only (defaults 26 and 9). */
  slow?: number
  signal?: number
  /** Computed on this higher timeframe (built from the strategy's candles; completed candles only). */
  timeframe?: Timeframe
}

function macdParams(i: IndicatorDef): string {
  return `${i.period}, ${i.slow ?? 26}, ${i.signal ?? 9}`
}

/** Optional entry filters: no new trade when the spread is too wide or outside the session. */
export interface EntryFilters {
  /** Largest bid/ask spread allowed for an entry, in price units (e.g. 0.40 = 40 cents on XAUUSD). */
  maxSpread?: number | null
  /** UTC trading window "HH:MM"–"HH:MM" (may wrap past midnight). */
  session?: { start: string; end: string } | null
  /** No entry when the close is more than this many ATR(14) away from EMA 20 (an extended move). */
  maxExtensionAtr?: number | null
  /** No entry after a candle whose range exceeds this many ATR(14) (a news spike). */
  abnormalRangeAtr?: number | null
  /** No entry while ATR(14) is outside this band (price units). */
  minAtr?: number | null
  maxAtr?: number | null
  /** High-risk periods you configure (e.g. scheduled economic releases), UTC ISO times: no new entries. */
  events?: { start: string; end: string; label: string }[] | null
}

export type PriceField = 'open' | 'high' | 'low' | 'close'
export type Operand = { type: 'indicator'; id: string } | { type: 'price'; field: PriceField } | { type: 'value'; value: number }
export type Comparator = '>' | '<' | '>=' | '<=' | 'crosses_above' | 'crosses_below'
export const COMPARATORS: Comparator[] = ['>', '<', '>=', '<=', 'crosses_above', 'crosses_below']
export const COMPARATOR_TEXT: Record<Comparator, string> = { '>': 'is above', '<': 'is below', '>=': 'is at or above', '<=': 'is at or below', crosses_above: 'crosses above', crosses_below: 'crosses below' }

export interface Condition {
  left: Operand
  op: Comparator
  right: Operand
}

export interface RuleGroup {
  match: 'all' | 'any'
  conditions: Condition[]
}

export type Direction = 'long' | 'short' | 'both'
export interface StopLoss {
  /** 'pips' is MetaTrader 5 only (forex): the pip size comes from the broker's symbol. */
  type: 'percent' | 'points' | 'atr' | 'pips'
  value: number
}
export interface TakeProfit {
  type: 'percent' | 'points' | 'risk_multiple' | 'pips'
  value: number
}
export interface Sizing {
  type: 'percent_equity' | 'risk_percent' | 'fixed_quantity'
  value: number
}

export interface StrategyRiskV2 {
  stopLoss: StopLoss | null
  takeProfit: TakeProfit | null
  sizing: Sizing | null
  /** Daily loss limits: at least one is required; whichever is reached first stops new entries. */
  maxDailyLossPct: number | null
  maxDailyLossUsd?: number | null
  maxTradesPerDay: number | null
  /**
   * Capital set aside for this strategy (USD). When set, percent-based sizing uses
   * min(allocated capital, account equity) instead of the whole account equity.
   */
  allocatedCapitalUsd?: number | null
  /** Cost assumption for backtests, not a trading rule. */
  feeBps: number
  /** No new entries for the rest of the UTC day after this many losing trades in a row. */
  maxConsecutiveLosses?: number | null
  /** Candles to wait after a trade closes before a new entry. */
  cooldownBars?: number | null
  /** Close a position after it has been open this many candles. */
  maxTradeBars?: number | null
}

export interface StrategyDefinition {
  version: 2
  /** Trading venue; missing means Delta Exchange (all strategies created before MT5 support). */
  venue?: BrokerId
  name: string
  description: string
  symbol: string
  timeframe: Timeframe | null
  direction: Direction | null
  indicators: IndicatorDef[]
  entry: { long: RuleGroup | null; short: RuleGroup | null }
  exit: { long: RuleGroup | null; short: RuleGroup | null }
  risk: StrategyRiskV2
  /** Entry filters (missing = none; all strategies created before them). */
  filters?: EntryFilters | null
}

export const LIMITS = {
  stopLoss: { percent: [0.05, 50], points: [0.00000001, 1e9], atr: [0.1, 20], pips: [0.1, 10000] } as Record<StopLoss['type'], [number, number]>,
  takeProfit: { percent: [0.05, 500], points: [0.00000001, 1e9], risk_multiple: [0.1, 20], pips: [0.1, 100000] } as Record<TakeProfit['type'], [number, number]>,
  sizing: { percent_equity: [0.1, 100], risk_percent: [0.01, 10], fixed_quantity: [0.00000001, 1e7] } as Record<Sizing['type'], [number, number]>,
  maxDailyLossPct: [0.1, 50] as [number, number],
  maxDailyLossUsd: [1, 1e7] as [number, number],
  allocatedCapitalUsd: [10, 1e8] as [number, number],
  maxTradesPerDay: [1, 100] as [number, number],
  feeBps: [0, 100] as [number, number],
  maxSpread: [0.00000001, 1e6] as [number, number],
  indicators: 12,
  conditionsPerGroup: 10
}
export const ATR_PERIOD_FOR_STOPS = 14
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const FX_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD', 'SEK', 'NOK', 'DKK', 'SGD', 'HKD', 'ZAR', 'MXN', 'TRY', 'PLN', 'CNH', 'HUF', 'CZK', 'ILS', 'THB'])

/** Metals, indices and other CFDs: symbols whose "pip" is not a forex pip (XAUUSD, GOLD, US30…). */
export function isMetalOrCfd(symbol: string): boolean {
  const s = symbol.toUpperCase()
  return !(FX_CURRENCIES.has(s.slice(0, 3)) && FX_CURRENCIES.has(s.slice(3, 6)))
}

export function describeFilters(f: EntryFilters | null | undefined): string[] {
  const out: string[] = []
  if (!f) return out
  if (isNum(f.maxSpread)) out.push(`No new trade while the bid/ask spread is wider than ${f.maxSpread} (price units).`)
  if (f.session) out.push(`New trades only between ${f.session.start} and ${f.session.end} UTC.`)
  if (isNum(f.maxExtensionAtr)) out.push(`No entry after an extended move: the close more than ${f.maxExtensionAtr} × ATR(14) away from EMA 20.`)
  if (isNum(f.abnormalRangeAtr)) out.push(`No entry after an abnormal candle (range above ${f.abnormalRangeAtr} × ATR).`)
  if (isNum(f.minAtr) || isNum(f.maxAtr)) out.push(`No entry while ATR(14) is ${isNum(f.minAtr) ? `below ${f.minAtr}` : ''}${isNum(f.minAtr) && isNum(f.maxAtr) ? ' or ' : ''}${isNum(f.maxAtr) ? `above ${f.maxAtr}` : ''}.`)
  if (f.events?.length) out.push(`No entry during ${f.events.length} configured high-risk event window${f.events.length === 1 ? '' : 's'}.`)
  return out
}

/** Higher-timeframe seconds (strategy and indicator timeframes). */
const TF_SEC: Record<Timeframe, number> = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 }

/** Closed candles the engine needs for this strategy's indicators to warm up (EMAs settle after ~3× their period). */
export function requiredBars(d: Pick<StrategyDefinition, 'timeframe' | 'indicators'>): number {
  const base = d.timeframe ? TF_SEC[d.timeframe] : 60
  let need = 320
  for (const i of d.indicators ?? []) {
    const mult = i.timeframe ? Math.max(1, Math.round(TF_SEC[i.timeframe] / base)) : 1
    const len = i.kind.startsWith('macd') ? (i.slow ?? 26) + (i.signal ?? 9) : i.period
    need = Math.max(need, (len * 3 + 10) * mult)
  }
  return Math.min(need, 6000)
}

export interface Issue {
  path: string
  message: string
}
export interface ValidationResult {
  valid: boolean
  errors: Issue[]
  warnings: Issue[]
}

export function emptyDefinition(symbol = 'BTCUSD', venue: BrokerId = 'delta'): StrategyDefinition {
  return {
    version: 2,
    ...(venue === 'mt5' ? { venue } : {}),
    name: '',
    description: '',
    symbol,
    timeframe: '1h',
    direction: 'long',
    indicators: [],
    entry: { long: { match: 'all', conditions: [] }, short: null },
    exit: { long: null, short: null },
    // MT5 costs are mostly the spread (taken from the candle data), so no extra fee by default
    risk: { stopLoss: null, takeProfit: null, sizing: null, maxDailyLossPct: null, maxDailyLossUsd: null, maxTradesPerDay: null, allocatedCapitalUsd: null, feeBps: venue === 'mt5' ? 0 : 5 }
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const inRange = (v: unknown, [lo, hi]: [number, number]) => isNum(v) && v >= lo && v <= hi
const ID_RE = /^[a-z][a-z0-9_]{0,23}$/

export function suggestIndicatorId(kind: IndicatorKind, period: number, taken: string[]): string {
  const base = `${kind}_${period}`.slice(0, 24)
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(`${base}_${i}`.slice(0, 24))) return `${base}_${i}`.slice(0, 24)
}

const operandKey = (o: Operand) => (o.type === 'indicator' ? `i:${o.id}` : o.type === 'price' ? `p:${o.field}` : `v:${o.value}`)
const conditionKey = (c: Condition) => `${operandKey(c.left)} ${c.op} ${operandKey(c.right)}`
const groupKey = (g: RuleGroup | null) => (g ? `${g.match}|${g.conditions.map(conditionKey).sort().join('&')}` : '')

function mirror(op: Comparator): Comparator {
  return ({ '>': '<', '<': '>', '>=': '<=', '<=': '>=', crosses_above: 'crosses_below', crosses_below: 'crosses_above' } as const)[op]
}

/** Normalizes "value op X" to "X mirror(op) value" so bounds on X can be compared. */
function boundOf(c: Condition): { key: string; op: Comparator; value: number } | null {
  if (c.right.type === 'value' && c.left.type !== 'value') return { key: operandKey(c.left), op: c.op, value: c.right.value }
  if (c.left.type === 'value' && c.right.type !== 'value') return { key: operandKey(c.right), op: mirror(c.op), value: c.left.value }
  return null
}

/** True when an "all" group can never be satisfied (e.g. RSI < 30 and RSI > 70). */
function contradictoryBounds(conditions: Condition[]): string | null {
  const bounds = new Map<string, { lo: number; loIncl: boolean; hi: number; hiIncl: boolean }>()
  for (const c of conditions) {
    const b = boundOf(c)
    if (!b || b.op.startsWith('crosses')) continue
    const cur = bounds.get(b.key) ?? { lo: -Infinity, loIncl: false, hi: Infinity, hiIncl: false }
    if (b.op === '>' || b.op === '>=') {
      if (b.value > cur.lo || (b.value === cur.lo && b.op === '>')) Object.assign(cur, { lo: b.value, loIncl: b.op === '>=' })
    } else if (b.value < cur.hi || (b.value === cur.hi && b.op === '<')) Object.assign(cur, { hi: b.value, hiIncl: b.op === '<=' })
    bounds.set(b.key, cur)
    if (cur.lo > cur.hi || (cur.lo === cur.hi && !(cur.loIncl && cur.hiIncl))) return b.key
  }
  // X > Y together with X < Y (or the mirrored form)
  const seen = new Set(conditions.map(conditionKey))
  for (const c of conditions) {
    if (c.left.type === 'value' || c.right.type === 'value') continue
    const opposite: Partial<Record<Comparator, Comparator[]>> = { '>': ['<', '<='], '>=': ['<'], '<': ['>', '>='], '<=': ['>'], crosses_above: ['crosses_below'], crosses_below: ['crosses_above'] }
    for (const o of opposite[c.op] ?? []) {
      if (seen.has(`${operandKey(c.left)} ${o} ${operandKey(c.right)}`) || seen.has(`${operandKey(c.right)} ${mirror(o)} ${operandKey(c.left)}`)) return operandKey(c.left)
    }
  }
  return null
}

export interface ValidationContext {
  /** Instruments listed for the strategy's venue (Delta region / MT5 broker); null when the list could not be loaded. */
  instruments: string[] | null
}

/** The venue a definition trades on (missing = Delta Exchange, for backward compatibility). */
export const venueOf = (d: Pick<StrategyDefinition, 'venue'> | null | undefined): BrokerId => (d?.venue === 'mt5' ? 'mt5' : 'delta')

/** Symbol syntax per venue: Delta tickers, or broker-specific MT5 names with suffixes (EURUSD.m, XAUUSD#). */
export const SYMBOL_PATTERN: Record<BrokerId, RegExp> = { delta: /^[A-Z0-9_]{2,32}$/, mt5: /^[A-Za-z0-9._#+!-]{1,32}$/ }

/**
 * Structural and semantic validation. Errors block enabling; warnings are shown but allowed.
 * Never fills anything in: missing values are reported, not defaulted.
 */
export function validateDefinition(d: StrategyDefinition, ctx: ValidationContext): ValidationResult {
  const errors: Issue[] = []
  const warnings: Issue[] = []
  const err = (path: string, message: string) => errors.push({ path, message })
  const warn = (path: string, message: string) => warnings.push({ path, message })

  if (!d || d.version !== 2) return { valid: false, errors: [{ path: '', message: 'Unsupported strategy format.' }], warnings }
  const name = (d.name ?? '').trim()
  if (!name || name.length > 80) err('name', 'Name is required (up to 80 characters).')
  if ((d.description ?? '').length > 2000) err('description', 'Description must be 2000 characters or fewer.')

  const venue = venueOf(d)
  if (d.venue !== undefined && d.venue !== 'delta' && d.venue !== 'mt5') err('venue', 'Choose Delta Exchange or MetaTrader 5.')
  if (!SYMBOL_PATTERN[venue].test(d.symbol ?? '')) err('symbol', 'Choose an instrument.')
  else if (ctx.instruments === null) err('symbol', venue === 'mt5' ? 'The MetaTrader 5 symbol list could not be loaded, so this symbol cannot be verified right now. Check that the MT5 terminal is running and connected (Settings → MetaTrader 5).' : 'The instrument list could not be loaded, so this instrument cannot be verified right now. Check the market data connection.')
  else if (!ctx.instruments.includes(d.symbol)) err('symbol', venue === 'mt5' ? `${d.symbol} is not offered by your MetaTrader 5 broker. Symbol names are broker-specific (for example EURUSD, EURUSD.m or EURUSD#).` : `${d.symbol} is not a live perpetual contract in your Delta Exchange region.`)
  if (venue === 'delta' && (d.risk?.stopLoss?.type === 'pips' || d.risk?.takeProfit?.type === 'pips')) {
    err(d.risk?.stopLoss?.type === 'pips' ? 'risk.stopLoss.type' : 'risk.takeProfit.type', 'Pips apply to MetaTrader 5 forex symbols only. On Delta Exchange use a percent, price points or ATR.')
  }

  if (!d.timeframe) err('timeframe', 'Choose a timeframe.')
  else if (!TIMEFRAMES.includes(d.timeframe)) err('timeframe', `Timeframe ${d.timeframe} is not supported. Use ${TIMEFRAMES.join(', ')}.`)
  if (!d.direction) err('direction', 'Choose whether the strategy buys (long), sells short, or both.')

  // ---- indicators ----
  const ids = new Set<string>()
  if (!Array.isArray(d.indicators)) err('indicators', 'Indicators are malformed.')
  else {
    if (d.indicators.length > LIMITS.indicators) err('indicators', `Use at most ${LIMITS.indicators} indicators.`)
    d.indicators.forEach((ind, i) => {
      const p = `indicators.${i}`
      const spec = INDICATORS[ind.kind]
      if (!spec) return err(`${p}.kind`, `Indicator "${ind.kind}" is not supported.`)
      if (!ID_RE.test(ind.id ?? '')) err(`${p}.id`, 'Name must start with a letter: lower-case letters, digits and _ (max 24).')
      else if (ids.has(ind.id)) err(`${p}.id`, `Indicator name "${ind.id}" is used twice.`)
      ids.add(ind.id)
      if (!inRange(ind.period, [spec.period[0], spec.period[1]]) || !Number.isInteger(ind.period)) err(`${p}.period`, `${spec.label} period must be a whole number from ${spec.period[0]} to ${spec.period[1]}.`)
      if (spec.stdDev && !inRange(ind.stdDev, [spec.stdDev[0], spec.stdDev[1]])) err(`${p}.stdDev`, `Band width must be ${spec.stdDev[0]}–${spec.stdDev[1]} standard deviations.`)
      if (ind.timeframe !== undefined && ind.timeframe !== null) {
        const tfs = TF_SEC[ind.timeframe]
        const base = d.timeframe ? TF_SEC[d.timeframe] : undefined
        if (!tfs || ind.kind === 'vwap') err(`${p}.timeframe`, 'This indicator cannot use another timeframe.')
        else if (base && (tfs <= base || tfs % base !== 0)) err(`${p}.timeframe`, `A ${ind.timeframe} indicator needs a lower strategy timeframe that divides it (for example 1m or 5m for 15m).`)
      }
      if (spec.slow && spec.signal) {
        const slow = ind.slow ?? spec.slow[2]
        const signal = ind.signal ?? spec.signal[2]
        if (!Number.isInteger(slow) || !inRange(slow, [spec.slow[0], spec.slow[1]]) || slow <= ind.period) err(`${p}.slow`, `MACD slow period must be a whole number from ${spec.slow[0]} to ${spec.slow[1]}, above the fast period.`)
        if (!Number.isInteger(signal) || !inRange(signal, [spec.signal[0], spec.signal[1]])) err(`${p}.signal`, `MACD signal period must be a whole number from ${spec.signal[0]} to ${spec.signal[1]}.`)
      }
    })
  }

  const operandProblem = (o: Operand): string | null => {
    if (!o || typeof o !== 'object') return 'Missing value.'
    if (o.type === 'indicator') return ids.has(o.id) ? null : `Indicator "${o.id}" is not defined.`
    if (o.type === 'price') return ['open', 'high', 'low', 'close'].includes(o.field) ? null : 'Choose a price field.'
    if (o.type === 'value') return isNum(o.value) ? null : 'Enter a number.'
    return 'Missing value.'
  }
  const kindOf = (o: Operand) => (o.type === 'indicator' ? d.indicators.find((x) => x.id === o.id)?.kind : undefined)

  const checkGroup = (g: RuleGroup | null, path: string, label: string, required: boolean) => {
    if (!g || g.conditions.length === 0) {
      if (required) err(path, `${label}: add at least one condition.`)
      return
    }
    if (g.match !== 'all' && g.match !== 'any') err(`${path}.match`, 'Choose whether all or any conditions must be true.')
    if (g.conditions.length > LIMITS.conditionsPerGroup) err(path, `${label}: at most ${LIMITS.conditionsPerGroup} conditions.`)
    g.conditions.forEach((c, i) => {
      const p = `${path}.conditions.${i}`
      const l = operandProblem(c.left)
      const r = operandProblem(c.right)
      if (l) err(`${p}.left`, l)
      if (r) err(`${p}.right`, r)
      if (!COMPARATORS.includes(c.op)) err(`${p}.op`, 'Choose a comparison.')
      if (l || r) return
      if (c.left.type === 'value' && c.right.type === 'value') err(p, 'Comparing two fixed numbers is always true or always false.')
      else if (operandKey(c.left) === operandKey(c.right)) err(p, 'A value cannot be compared with itself.')
      for (const [side, other] of [[c.left, c.right], [c.right, c.left]] as const) {
        const spec = kindOf(side) ? INDICATORS[kindOf(side)!] : undefined
        if (spec?.range && other.type === 'value' && (other.value < spec.range[0] || other.value > spec.range[1])) {
          err(p, `${spec.label} only ranges from ${spec.range[0]} to ${spec.range[1]}, so comparing it with ${other.value} can never change.`)
        }
      }
      const scales = [c.left, c.right].map((o) => (o.type === 'price' ? 'price' : o.type === 'indicator' ? INDICATORS[kindOf(o)!]?.scale : null)).filter(Boolean)
      if (scales.length === 2 && scales[0] !== scales[1]) warn(p, 'This compares values on different scales (for example a price with an oscillator). Check it is intended.')
    })
    if (g.match === 'all') {
      const bad = contradictoryBounds(g.conditions)
      if (bad) err(path, `${label}: these conditions contradict each other and can never all be true.`)
    }
  }

  const dir = d.direction
  const wantsLong = dir === 'long' || dir === 'both'
  const wantsShort = dir === 'short' || dir === 'both'
  checkGroup(d.entry?.long ?? null, 'entry.long', 'Buy (long entry) rules', wantsLong)
  checkGroup(d.entry?.short ?? null, 'entry.short', 'Sell short (short entry) rules', wantsShort)
  checkGroup(d.exit?.long ?? null, 'exit.long', 'Long exit rules', false)
  checkGroup(d.exit?.short ?? null, 'exit.short', 'Short exit rules', false)
  if (dir === 'long' && d.entry?.short?.conditions.length) err('entry.short', 'Short entry rules are set, but the strategy only buys (long). Remove them or choose "both".')
  if (dir === 'short' && d.entry?.long?.conditions.length) err('entry.long', 'Buy rules are set, but the strategy only sells short. Remove them or choose "both".')
  if (d.entry?.long?.conditions.length && groupKey(d.entry.long) === groupKey(d.exit?.long ?? null)) err('exit.long', 'The long exit rules are identical to the buy rules, so every trade would close immediately.')
  if (d.entry?.short?.conditions.length && groupKey(d.entry.short) === groupKey(d.exit?.short ?? null)) err('exit.short', 'The short exit rules are identical to the short entry rules.')
  if (dir === 'both' && d.entry?.long?.conditions.length && groupKey(d.entry.long) === groupKey(d.entry?.short ?? null)) err('entry.short', 'Buy and sell-short rules are identical, so both would trigger together.')

  // ---- risk ----
  const r = d.risk
  if (!r) err('risk', 'Risk settings are missing.')
  else {
    if (!r.stopLoss) err('risk.stopLoss', 'A stop-loss is required.')
    else if (!LIMITS.stopLoss[r.stopLoss.type]) err('risk.stopLoss.type', 'Choose a stop-loss type.')
    else if (!inRange(r.stopLoss.value, LIMITS.stopLoss[r.stopLoss.type])) err('risk.stopLoss.value', `Stop-loss must be between ${LIMITS.stopLoss[r.stopLoss.type][0]} and ${LIMITS.stopLoss[r.stopLoss.type][1]}${r.stopLoss.type === 'percent' ? '%' : ''}.`)
    if (r.takeProfit) {
      if (!LIMITS.takeProfit[r.takeProfit.type]) err('risk.takeProfit.type', 'Choose a take-profit type.')
      else if (!inRange(r.takeProfit.value, LIMITS.takeProfit[r.takeProfit.type])) err('risk.takeProfit.value', `Take-profit must be between ${LIMITS.takeProfit[r.takeProfit.type][0]} and ${LIMITS.takeProfit[r.takeProfit.type][1]}.`)
      else if (r.stopLoss && r.takeProfit.type === r.stopLoss.type && r.takeProfit.value < r.stopLoss.value * 0.25) warn('risk.takeProfit.value', 'Take-profit is much closer than the stop-loss; check the reward/risk ratio.')
    } else if (!d.exit?.long?.conditions.length && !d.exit?.short?.conditions.length) {
      warn('risk.takeProfit', 'No take-profit and no exit rules: positions close only at the stop-loss.')
    }
    if (!r.sizing) err('risk.sizing', 'Position sizing is required.')
    else if (!LIMITS.sizing[r.sizing.type]) err('risk.sizing.type', 'Choose a sizing method.')
    else if (!inRange(r.sizing.value, LIMITS.sizing[r.sizing.type])) err('risk.sizing.value', `Position size must be between ${LIMITS.sizing[r.sizing.type][0]} and ${LIMITS.sizing[r.sizing.type][1]}.`)
    const hasPct = r.maxDailyLossPct !== null && r.maxDailyLossPct !== undefined
    const hasUsd = r.maxDailyLossUsd !== null && r.maxDailyLossUsd !== undefined
    if (!hasPct && !hasUsd) err('risk.maxDailyLossPct', 'Set a maximum daily loss (percent of equity or a dollar amount).')
    if (hasPct && !inRange(r.maxDailyLossPct, LIMITS.maxDailyLossPct)) err('risk.maxDailyLossPct', `Maximum daily loss must be ${LIMITS.maxDailyLossPct[0]}–${LIMITS.maxDailyLossPct[1]}% of equity.`)
    if (hasUsd && !inRange(r.maxDailyLossUsd, LIMITS.maxDailyLossUsd)) err('risk.maxDailyLossUsd', `Maximum daily loss must be $${LIMITS.maxDailyLossUsd[0]}–$${LIMITS.maxDailyLossUsd[1].toLocaleString('en-US')}.`)
    const capital = r.allocatedCapitalUsd
    if (capital !== null && capital !== undefined) {
      if (!inRange(capital, LIMITS.allocatedCapitalUsd)) err('risk.allocatedCapitalUsd', `Allocated capital must be $${LIMITS.allocatedCapitalUsd[0]}–$${LIMITS.allocatedCapitalUsd[1].toLocaleString('en-US')}.`)
      else if (hasUsd && isNum(r.maxDailyLossUsd) && r.maxDailyLossUsd >= capital) err('risk.maxDailyLossUsd', 'The daily loss limit is as large as the whole allocated capital. Lower it or allocate more capital.')
      else if (r.sizing?.type === 'risk_percent' && hasUsd && isNum(r.maxDailyLossUsd) && (capital * r.sizing.value) / 100 > r.maxDailyLossUsd) {
        err('risk.sizing.value', `One losing trade (${r.sizing.value}% of $${capital}) would already exceed the $${r.maxDailyLossUsd} daily loss limit.`)
      }
    }
    if (r.maxTradesPerDay === null || r.maxTradesPerDay === undefined) err('risk.maxTradesPerDay', 'Set a maximum number of trades per day.')
    else if (!inRange(r.maxTradesPerDay, LIMITS.maxTradesPerDay) || !Number.isInteger(r.maxTradesPerDay)) err('risk.maxTradesPerDay', `Trades per day must be a whole number from ${LIMITS.maxTradesPerDay[0]} to ${LIMITS.maxTradesPerDay[1]}.`)
    if (!inRange(r.feeBps, LIMITS.feeBps)) err('risk.feeBps', `Fees must be ${LIMITS.feeBps[0]}–${LIMITS.feeBps[1]} basis points.`)
    if (r.sizing?.type === 'risk_percent' && isNum(r.maxDailyLossPct) && r.sizing.value > r.maxDailyLossPct) {
      err('risk.sizing.value', 'One losing trade would already exceed the maximum daily loss. Lower the risk per trade or raise the daily limit.')
    }
    if (r.stopLoss?.type === 'atr' && !d.indicators.some((i) => i.kind === 'atr')) {
      warn('risk.stopLoss.type', `ATR stops use a ${ATR_PERIOD_FOR_STOPS}-candle ATR computed automatically.`)
    }
    for (const [k, lo, hi, text] of [['maxConsecutiveLosses', 1, 50, 'Losses in a row'], ['cooldownBars', 0, 1000, 'Cooldown'], ['maxTradeBars', 1, 100000, 'Maximum trade duration']] as const) {
      const v = r[k]
      if (v !== null && v !== undefined && (!Number.isInteger(v) || v < lo || v > hi)) err(`risk.${k}`, `${text} must be a whole number from ${lo} to ${hi}.`)
    }
    if (venue === 'mt5' && (r.stopLoss?.type === 'pips' || r.takeProfit?.type === 'pips') && isMetalOrCfd(d.symbol)) {
      warn(r.stopLoss?.type === 'pips' ? 'risk.stopLoss.type' : 'risk.takeProfit.type', `What a "pip" means for ${d.symbol} differs between brokers. Use a price distance (points) or ATR instead.`)
    }
  }
  // ---- entry filters ----
  const f = d.filters
  if (f !== null && f !== undefined) {
    if (typeof f !== 'object') err('filters', 'Entry filters are malformed.')
    else {
      if (f.maxSpread !== null && f.maxSpread !== undefined && !inRange(f.maxSpread, LIMITS.maxSpread)) err('filters.maxSpread', `Maximum spread must be a price distance from ${LIMITS.maxSpread[0]} to ${LIMITS.maxSpread[1]}.`)
      if (f.session) {
        if (!HHMM.test(f.session.start ?? '') || !HHMM.test(f.session.end ?? '')) err('filters.session', 'Session times must be HH:MM (UTC), for example 07:00 and 20:00.')
        else if (f.session.start === f.session.end) err('filters.session', 'The session start and end must differ.')
      }
      for (const k of ['maxExtensionAtr', 'abnormalRangeAtr', 'minAtr', 'maxAtr'] as const) {
        const v = f[k]
        if (v !== null && v !== undefined && !(isNum(v) && v > 0 && v <= 1e6)) err(`filters.${k}`, 'Enter a positive number.')
      }
      if (isNum(f.minAtr) && isNum(f.maxAtr) && f.minAtr >= f.maxAtr) err('filters.maxAtr', 'The maximum ATR must be above the minimum.')
      if (f.events) {
        if (!Array.isArray(f.events) || f.events.length > 200) err('filters.events', 'At most 200 high-risk events.')
        else f.events.forEach((e, i) => {
          const a = Date.parse(e?.start ?? '')
          const b = Date.parse(e?.end ?? '')
          if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b) err(`filters.events.${i}`, 'Each high-risk event needs a start before its end (UTC).')
        })
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings }
}

// ---------- plain-language explanation (deterministic, never AI-generated) ----------
function operandText(o: Operand, d: StrategyDefinition): string {
  if (o.type === 'price') return `the ${o.field} price`
  if (o.type === 'value') return String(o.value)
  const ind = d.indicators.find((i) => i.id === o.id)
  return ind ? `the ${INDICATORS[ind.kind].explain(ind)}${ind.timeframe ? ` on ${ind.timeframe} candles` : ''}` : `"${o.id}" (undefined)`
}

export function describeGroup(g: RuleGroup | null, d: StrategyDefinition): string {
  if (!g || g.conditions.length === 0) return ''
  const parts = g.conditions.map((c) => `${operandText(c.left, d)} ${COMPARATOR_TEXT[c.op]} ${operandText(c.right, d)}`)
  return parts.length === 1 ? parts[0]! : `${g.match === 'all' ? 'all of' : 'any of'}: ${parts.join('; ')}`
}

export function describeStop(s: StopLoss | null): string {
  if (!s) return 'not set'
  if (s.type === 'pips') return `${s.value} pips from the entry price`
  return s.type === 'percent' ? `${s.value}% from the entry price` : s.type === 'points' ? `${s.value} price units from the entry price` : `${s.value} × ATR(${ATR_PERIOD_FOR_STOPS}) from the entry price`
}

export function describeTarget(t: TakeProfit | null): string {
  if (!t) return 'none'
  if (t.type === 'pips') return `${t.value} pips from the entry price`
  return t.type === 'percent' ? `${t.value}% from the entry price` : t.type === 'points' ? `${t.value} price units from the entry price` : `${t.value} × the stop-loss distance`
}

export function describeSizing(s: Sizing | null, venue: BrokerId = 'delta'): string {
  if (!s) return 'not set'
  if (s.type === 'fixed_quantity' && venue === 'mt5') return `${s.value} lots per trade`
  return s.type === 'percent_equity' ? `${s.value}% of equity per trade` : s.type === 'risk_percent' ? `sized so a stop-out loses ${s.value}% of equity` : `${s.value} units per trade`
}

const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
/** MT5 amounts are in the account currency (USD, EUR, …); Delta limits are USD. */
const amount = (n: number, venue: BrokerId) => (venue === 'mt5' ? `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} (account currency)` : usd(n))

/** Sizing text that names the capital base actually used. */
export function describeSizingFor(r: StrategyRiskV2, venue: BrokerId = 'delta'): string {
  const s = r.sizing
  if (!s || s.type === 'fixed_quantity' || !isNum(r.allocatedCapitalUsd)) return describeSizing(s, venue)
  const base = `the ${amount(r.allocatedCapitalUsd, venue)} allocated capital (or the account equity, if lower)`
  return s.type === 'percent_equity' ? `${s.value}% of ${base} per trade` : `sized so a stop-out loses ${s.value}% of ${base}`
}

export function describeDailyLoss(r: StrategyRiskV2, venue: BrokerId = 'delta'): string {
  const parts: string[] = []
  if (isNum(r.maxDailyLossPct)) parts.push(`${r.maxDailyLossPct}% of equity`)
  if (isNum(r.maxDailyLossUsd)) parts.push(amount(r.maxDailyLossUsd, venue))
  return parts.length ? parts.join(' or ') + (parts.length > 1 ? ' (whichever is reached first)' : '') : 'not set'
}

export interface StrategyExplanation {
  entry: string[]
  exit: string[]
  risk: string[]
}

/** Explains how the rules behave in the backtester, so nothing about execution is implied. */
export function explainDefinition(d: StrategyDefinition): StrategyExplanation {
  const entry: string[] = []
  const exit: string[] = []
  const tf = d.timeframe ?? '?'
  if (d.entry.long?.conditions.length) entry.push(`Buy (go long) ${d.symbol} when ${describeGroup(d.entry.long, d)}.`)
  if (d.entry.short?.conditions.length) entry.push(`Sell short ${d.symbol} when ${describeGroup(d.entry.short, d)}.`)
  if (entry.length) entry.push(...describeFilters(d.filters))
  if (entry.length) entry.push(`Conditions are checked when each ${tf} candle closes. In automation a market order is sent right after the close; backtests fill at the next candle's open. Only one position is open at a time.`)
  else entry.push('No entry rules yet, so the strategy would never open a position.')
  if (d.exit.long?.conditions.length) exit.push(`Close a long position when ${describeGroup(d.exit.long, d)}.`)
  if (d.exit.short?.conditions.length) exit.push(`Close a short position when ${describeGroup(d.exit.short, d)}.`)
  exit.push(`Stop-loss: ${describeStop(d.risk.stopLoss)}.`)
  exit.push(`Take-profit: ${describeTarget(d.risk.takeProfit)}.`)
  const venue = venueOf(d)
  exit.push(
    venue === 'mt5'
      ? 'In live automation the stop-loss and take-profit are attached to the position at your MetaTrader 5 broker with the entry order. Backtests check them against each candle’s high and low; if both are touched in the same candle the stop is assumed to fill first.'
      : 'In live automation the stop-loss and take-profit are placed on the exchange with the entry order. Backtests check them against each candle’s high and low; if both are touched in the same candle the stop is assumed to fill first.'
  )
  if (venue === 'mt5' && (d.risk.stopLoss?.type === 'pips' || d.risk.takeProfit?.type === 'pips')) {
    exit.push('A pip is the broker\'s pip size for the symbol: 0.0001 on most forex pairs, 0.01 on JPY pairs (10 points on 3- and 5-digit quotes).')
  }
  const risk = [
    `Position size: ${describeSizingFor(d.risk, venue)}${venue === 'mt5' && d.risk.sizing?.type !== 'fixed_quantity' ? ', rounded down to the broker\'s lot step' : ''}.`,
    ...(isNum(d.risk.allocatedCapitalUsd) ? [`Allocated capital: ${amount(d.risk.allocatedCapitalUsd, venue)}. This only sets the base for position sizing; it does not reserve or move funds on the exchange.`] : []),
    `Daily limits: maximum realized loss ${describeDailyLoss(d.risk, venue)}; ${d.risk.maxTradesPerDay != null ? `at most ${d.risk.maxTradesPerDay} trades` : 'trade limit not set'} per UTC day. After either limit, no new trades open until the next day.`,
    ...(isNum(d.risk.maxConsecutiveLosses) ? [`After ${d.risk.maxConsecutiveLosses} losing trades in a row, no new trades until the next UTC day.`] : []),
    ...(isNum(d.risk.cooldownBars) && d.risk.cooldownBars > 0 ? [`After each trade, wait ${d.risk.cooldownBars} candle${d.risk.cooldownBars === 1 ? '' : 's'} before a new entry.`] : []),
    ...(isNum(d.risk.maxTradeBars) ? [`A position open for ${d.risk.maxTradeBars} candles is closed at market (maximum trade duration).`] : []),
    venue === 'mt5'
      ? `Backtest cost assumption: ${d.risk.feeBps} basis points per side plus the broker's spread from the candle data (buys fill at the ask).`
      : `Backtest fee assumption: ${d.risk.feeBps} basis points per side.`,
    ...(venue === 'mt5' ? ['Forex and CFD markets close on weekends and between sessions: no orders are sent while a market is closed, and the broker may fill at a different price after a gap.'] : [])
  ]
  return { entry, exit, risk }
}

// ---------- conversion of Phase 1–2 template strategies ----------
export interface LegacyStrategy {
  name: string
  symbol: string
  timeframe: Timeframe
  type: 'sma_cross' | 'ema_cross' | 'rsi_reversion' | 'breakout'
  params: Record<string, number>
  risk: { positionPct: number; stopLossPct: number; takeProfitPct: number; feeBps: number }
  allowShort: boolean
  notes: string
}

/** Faithful translation of the old templates (same entries/exits as the old engine), with explicit daily limits left unset. */
export function convertLegacy(s: LegacyStrategy): StrategyDefinition {
  const ind = (kind: IndicatorKind, period: number): IndicatorDef => ({ id: `${kind}_${period}`, kind, period })
  const I = (id: string): Operand => ({ type: 'indicator', id })
  const close: Operand = { type: 'price', field: 'close' }
  const V = (value: number): Operand => ({ type: 'value', value })
  const one = (c: Condition): RuleGroup => ({ match: 'all', conditions: [c] })
  let indicators: IndicatorDef[] = []
  let le: RuleGroup, lx: RuleGroup, se: RuleGroup, sx: RuleGroup
  if (s.type === 'sma_cross' || s.type === 'ema_cross') {
    const k = s.type === 'sma_cross' ? 'sma' : 'ema'
    const f = ind(k, s.params.fast ?? 10)
    const sl = ind(k, s.params.slow ?? 30)
    indicators = f.id === sl.id ? [f] : [f, sl]
    le = one({ left: I(f.id), op: 'crosses_above', right: I(sl.id) })
    lx = one({ left: I(f.id), op: 'crosses_below', right: I(sl.id) })
    se = lx
    sx = le
  } else if (s.type === 'rsi_reversion') {
    const r = ind('rsi', s.params.period ?? 14)
    indicators = [r]
    le = one({ left: I(r.id), op: '<', right: V(s.params.oversold ?? 30) })
    lx = one({ left: I(r.id), op: '>=', right: V(50) })
    se = one({ left: I(r.id), op: '>', right: V(s.params.overbought ?? 70) })
    sx = one({ left: I(r.id), op: '<=', right: V(50) })
  } else {
    const n = s.params.lookback ?? 20
    const hh = ind('highest_high', n)
    const ll = ind('lowest_low', n)
    indicators = [hh, ll]
    le = one({ left: close, op: '>', right: I(hh.id) })
    lx = one({ left: close, op: '<', right: I(ll.id) })
    se = lx
    sx = le
  }
  return {
    version: 2,
    name: s.name,
    description: s.notes ?? '',
    symbol: s.symbol,
    timeframe: s.timeframe,
    direction: s.allowShort ? 'both' : 'long',
    indicators,
    entry: { long: le, short: s.allowShort ? se : null },
    exit: { long: lx, short: s.allowShort ? sx : null },
    risk: {
      stopLoss: s.risk.stopLossPct > 0 ? { type: 'percent', value: s.risk.stopLossPct } : null,
      takeProfit: s.risk.takeProfitPct > 0 ? { type: 'percent', value: s.risk.takeProfitPct } : null,
      sizing: { type: 'percent_equity', value: s.risk.positionPct },
      maxDailyLossPct: null,
      maxDailyLossUsd: null,
      maxTradesPerDay: null,
      allocatedCapitalUsd: null,
      feeBps: s.risk.feeBps
    }
  }
}


// ---------- change review (deterministic) ----------
export interface DefinitionChange {
  field: string
  before: string
  after: string
}

/** Plain-language list of what differs between two definitions, for reviewing an AI-proposed edit. */
export function diffDefinitions(a: StrategyDefinition, b: StrategyDefinition): DefinitionChange[] {
  const out: DefinitionChange[] = []
  const add = (field: string, before: string, after: string) => {
    if (before !== after) out.push({ field, before: before || '—', after: after || '—' })
  }
  add('Broker', venueOf(a) === 'mt5' ? 'MetaTrader 5' : 'Delta Exchange', venueOf(b) === 'mt5' ? 'MetaTrader 5' : 'Delta Exchange')
  add('Name', a.name, b.name)
  add('Description', a.description, b.description)
  add('Instrument', a.symbol, b.symbol)
  add('Timeframe', a.timeframe ?? '', b.timeframe ?? '')
  add('Direction', a.direction ?? '', b.direction ?? '')
  add('Buy rules', describeGroup(a.entry.long, a), describeGroup(b.entry.long, b))
  add('Sell-short rules', describeGroup(a.entry.short, a), describeGroup(b.entry.short, b))
  add('Long exit rules', describeGroup(a.exit.long, a), describeGroup(b.exit.long, b))
  add('Short exit rules', describeGroup(a.exit.short, a), describeGroup(b.exit.short, b))
  add('Stop-loss', describeStop(a.risk.stopLoss), describeStop(b.risk.stopLoss))
  add('Take-profit', describeTarget(a.risk.takeProfit), describeTarget(b.risk.takeProfit))
  add('Position size', describeSizingFor(a.risk, venueOf(a)), describeSizingFor(b.risk, venueOf(b)))
  add('Allocated capital', isNum(a.risk.allocatedCapitalUsd) ? usd(a.risk.allocatedCapitalUsd) : 'not set', isNum(b.risk.allocatedCapitalUsd) ? usd(b.risk.allocatedCapitalUsd) : 'not set')
  add('Daily loss limit', describeDailyLoss(a.risk), describeDailyLoss(b.risk))
  add('Trades per day', String(a.risk.maxTradesPerDay ?? 'not set'), String(b.risk.maxTradesPerDay ?? 'not set'))
  add('Backtest fee assumption', `${a.risk.feeBps} bps`, `${b.risk.feeBps} bps`)
  add('Entry filters', describeFilters(a.filters).join(' ') || 'none', describeFilters(b.filters).join(' ') || 'none')
  return out
}
