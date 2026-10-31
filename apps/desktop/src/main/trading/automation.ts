import { createHash, randomUUID } from 'node:crypto'
import { audit, getSetting, setSetting, transaction, type Db } from '../db.js'
import { UserError } from '../errors.js'
import { ProviderError } from '../net.js'
import { redact } from '../redact.js'
import { TF_SECONDS } from '../marketData.js'
import { MAX_BACKTEST_DAYS } from '../../shared/strategySpec.js'
import { DEFAULT_RISK, validateRisk, type TradingRiskSettings } from '../../shared/tradingRisk.js'
import { requiredBars, venueOf, type StrategyDefinition, type ValidationResult } from '../../shared/strategyRules.js'
import { isValidVolume, sameVolume, sizingSpecOf, type SizingSpec } from '../../shared/sizing.js'
import { BROKER_LABEL } from '../../shared/ipc.js'
import type {
  AutoOrderView,
  AutoPosition,
  AutoTradeView,
  AutomationEventView,
  BrokerId,
  AutomationMode,
  AutomationSessionView,
  Candle,
  Instrument,
  OrderState,
  Strategy,
  StrategyActivity,
  Timeframe,
  TradingOverview
} from '../../shared/ipc.js'
import type { ExchangeAdapter, OrderResult } from './exchange.js'

/** Number of closed candles handed to the engine (indicator warm-up). */
const LOOKBACK = 320
const TICK_MS = 5_000
const RECONCILE_MS = 15_000
const CANDLE_GRACE_SEC = 3
const UNKNOWN_ORDER_GIVE_UP_MS = 60_000

export interface EngineDecision {
  candleTime: number
  signals: Record<string, boolean>
  blockedBy: string[]
  intent: { action: 'none' | 'open_long' | 'open_short' | 'close'; reason: string; contracts?: number; estPrice?: number; notionalUsd?: number; stopPrice?: number | null; takePrice?: number | null; notes?: string[] }
}

/** Everything that differs per broker. */
export interface VenueDeps {
  candles: (symbol: string, timeframe: Timeframe, days: number) => Promise<Candle[]>
  instruments: () => Promise<Instrument[]>
  /** Fresh spec for one symbol (MT5: tick value changes with prices); cached list otherwise. */
  instrument?: (symbol: string) => Promise<Instrument>
  markPrice: (symbol: string) => Promise<number>
  /** Bid/ask, where the venue quotes them (paper stops check the side that would close). */
  quote?: (symbol: string) => Promise<{ bid: number; ask: number }>
  /** False while the market is closed; venues that never close omit it. */
  isMarketOpen?: (symbol: string) => Promise<boolean>
  /** Live adapter, or null when the broker is not configured. */
  liveExchange: () => ExchangeAdapter | null
  paperExchange: ExchangeAdapter
  /** Live account equity / available funds in the account (settlement) currency. */
  liveAccount: () => Promise<{ equity: number; available: number | null }>
  liveChecks: () => { id: string; label: string; ok: boolean; detail: string }[]
  region: () => { id: string; label: string; testnet: boolean }
  watchSymbols: (symbols: string[]) => void
  /** The account the broker connection is logged in to right now (MT5: login and demo/real). */
  accountIdentity?: () => Promise<AccountIdentity | null>
  /** Positions TradePilot holds outside automations (manual Gold Bot trades): they count toward the limits. */
  extraOpen?: () => Promise<{ count: number; exposure: number }>
}

export interface AccountIdentity {
  login: string
  mode: 'demo' | 'contest' | 'real'
}

export interface StartOptions {
  /** Refuse to start (and later to trade) unless the account is a demo account, or a real-money one. */
  requireAccount?: 'demo' | 'live'
}

/** The top-level venue fields are Delta Exchange's (unchanged); other brokers come in `venues`. */
export interface AutomationDeps extends VenueDeps {
  db: Db
  now?: () => number
  engine: <T>(method: string, params: unknown) => Promise<T>
  strategy: (id: string) => Promise<Strategy | null>
  /** Validates a pinned definition snapshot with the same rules as the strategy store. */
  validate?: (d: StrategyDefinition) => Promise<ValidationResult>
  venues?: Partial<Record<Exclude<BrokerId, 'delta'>, VenueDeps>>
  alert: (a: { level: 'info' | 'warning' | 'error'; title: string; body: string; key: string }) => void
  onChange: () => void
  log?: (msg: string) => void
  sleep?: (ms: number) => Promise<void>
}

interface SessionRow {
  id: string
  broker: BrokerId
  strategy_id: string | null
  strategy_name: string
  symbol: string
  product_id: number
  timeframe: Timeframe
  mode: AutomationMode
  status: 'running' | 'paused' | 'stopped'
  started_at: string
  stopped_at: string | null
  stop_reason: string | null
  last_candle: number | null
  last_signal_candle: number | null
  last_evaluated_at: string | null
  last_decision: string | null
  position: string | null
  entries_blocked_reason: string | null
  day_key: string | null
  day_trades: number
  day_realized_pnl: number
  day_start_equity: number | null
  strategy_version: number | null
  /** Snapshot of the strategy version this session runs. */
  definition: string | null
  /** Live MT5: JSON AccountIdentity the session was started on. */
  account_guard?: string | null
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const cid = (prefix: string, key: string) => `${prefix}${createHash('sha256').update(key).digest('hex').slice(0, 30)}`

/**
 * Runs approved strategies. Decisions come from the Python engine; this class executes
 * them only after its own independent checks, records every order with a client order id
 * derived from the signal (so one signal can never produce two orders), reconciles local
 * state with the exchange, and enforces the emergency stop.
 */
export class AutomationService {
  private timer: NodeJS.Timeout | null = null
  private busy = new Set<string>()
  private lastReconcile = 0
  private lastReconcileAt: string | null = null
  private lastExchangeError: string | null = null
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private instrumentCache: Map<string, Instrument> = new Map()

  constructor(private readonly d: AutomationDeps) {
    this.now = d.now ?? (() => Date.now())
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  // ---------- settings ----------
  risk(): TradingRiskSettings {
    return { ...DEFAULT_RISK, ...getSetting<Partial<TradingRiskSettings>>(this.d.db, 'trading.risk', {}) }
  }

  saveRisk(r: TradingRiskSettings): void {
    const errors = validateRisk(r)
    if (Object.keys(errors).length) throw new UserError('validation_failed', 'Please correct the highlighted risk settings.', errors)
    setSetting(this.d.db, 'trading.risk', { ...r, configured: true })
    audit(this.d.db, 'trading.risk_saved', { ...r })
    this.event(null, 'info', 'Risk settings saved.')
  }

  /** The broker's dependencies. Delta's are the top-level fields; others must be wired in. */
  private v(broker: BrokerId): VenueDeps {
    if (broker === 'delta') return this.d
    const venue = this.d.venues?.[broker]
    if (!venue) throw new UserError('broker_unavailable', 'MetaTrader 5 is not available in this build.')
    return venue
  }

  /** Live trading is enabled per broker (Delta keeps its original setting key). */
  liveEnabled(broker: BrokerId = 'delta'): { enabled: boolean; enabledAt: string | null } {
    return getSetting(this.d.db, broker === 'delta' ? 'trading.live' : `trading.live.${broker}`, { enabled: false, enabledAt: null })
  }

  setLive(enabled: boolean, broker: BrokerId = 'delta'): void {
    const venue = this.v(broker)
    if (enabled) {
      const failing = venue.liveChecks().filter((c) => !c.ok)
      if (failing.length) throw new UserError('live_checks_failed', `Live trading cannot be enabled: ${failing.map((c) => c.detail).join(' ')}`)
      if (!this.risk().configured) throw new UserError('risk_not_configured', 'Configure the account risk settings first.')
    }
    setSetting(this.d.db, broker === 'delta' ? 'trading.live' : `trading.live.${broker}`, { enabled, enabledAt: enabled ? new Date(this.now()).toISOString() : null })
    audit(this.d.db, enabled ? 'trading.live_enabled' : 'trading.live_disabled', broker === 'delta' ? undefined : { broker })
    if (!enabled) {
      // no new live orders; positions keep their exchange-side protection
      for (const s of this.rows("status = 'running' AND mode = 'live' AND broker = ?", broker)) this.setStatus(s.id, 'paused', 'live trading was turned off')
    }
    this.event(null, enabled ? 'warning' : 'info', enabled ? `Live trading ENABLED on ${venue.region().label}.` : `Live trading disabled${broker === 'delta' ? '' : ` on ${venue.region().label}`}. Running live automations were paused.`)
    this.d.onChange()
  }

  emergency(): { active: boolean; at: string | null; detail: string | null } {
    return getSetting(this.d.db, 'trading.emergency', { active: false, at: null, detail: null })
  }

  // ---------- persistence helpers ----------
  private rows(where = '1=1', ...args: (string | number)[]): SessionRow[] {
    return this.d.db.prepare(`SELECT * FROM automation_sessions WHERE ${where} ORDER BY started_at DESC`).all(...args) as unknown as SessionRow[]
  }

  private row(id: string): SessionRow {
    const r = this.d.db.prepare('SELECT * FROM automation_sessions WHERE id = ?').get(id) as SessionRow | undefined
    if (!r) throw new UserError('not_found', 'Automation not found.')
    return r
  }

  private update(id: string, patch: Partial<Omit<SessionRow, 'id'>>): void {
    const keys = Object.keys(patch)
    if (!keys.length) return
    this.d.db.prepare(`UPDATE automation_sessions SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (patch as Record<string, unknown>)[k] as never), new Date(this.now()).toISOString(), id)
  }

  private position(s: SessionRow): AutoPosition | null {
    return s.position ? (JSON.parse(s.position) as AutoPosition) : null
  }

  event(sessionId: string | null, level: 'info' | 'warning' | 'error', message: string, alertTitle?: string): void {
    const msg = redact(message).slice(0, 800)
    this.d.db.prepare('INSERT INTO automation_events (session_id, level, message, created_at) VALUES (?, ?, ?, ?)').run(sessionId, level, msg, new Date(this.now()).toISOString())
    this.d.log?.(`automation ${level}: ${msg}`)
    if (alertTitle) this.d.alert({ level, title: alertTitle, body: msg, key: `${alertTitle}:${sessionId ?? ''}` })
  }

  private setStatus(id: string, status: SessionRow['status'], reason?: string): void {
    const iso = new Date(this.now()).toISOString()
    this.update(id, status === 'stopped' ? { status, stopped_at: iso, stop_reason: reason ?? null } : status === 'paused' ? { status, paused_at: iso } as never : { status })
    if (reason) this.event(id, 'info', `${status === 'stopped' ? 'Stopped' : status === 'paused' ? 'Paused' : 'Resumed'}: ${reason}.`)
  }

  private async instrument(symbol: string, broker: BrokerId = 'delta'): Promise<Instrument & { sizing: SizingSpec }> {
    const venue = this.v(broker)
    let inst: Instrument | undefined
    if (venue.instrument) {
      // read fresh: the value per point of forex crosses moves with prices
      inst = await venue.instrument(symbol).catch((err) => {
        throw new UserError('unsupported_symbol', `${symbol} is not available at your MetaTrader 5 broker: ${err instanceof Error ? err.message : err}`)
      })
    } else {
      const key = `${broker}:${symbol}`
      if (!this.instrumentCache.has(key)) {
        const list = await venue.instruments()
        for (const k of [...this.instrumentCache.keys()]) if (k.startsWith(`${broker}:`)) this.instrumentCache.delete(k)
        for (const i of list) this.instrumentCache.set(`${broker}:${i.symbol}`, i)
      }
      inst = this.instrumentCache.get(key)
    }
    if (!inst) throw new UserError('unsupported_symbol', `${symbol} is not a live contract on the connected Delta Exchange account region.`)
    const sizing = sizingSpecOf(inst)
    if (!sizing) throw new UserError('unsupported_symbol', `${symbol} has no contract size information; it cannot be traded automatically.`)
    return { ...inst, sizing }
  }

  private adapter(mode: AutomationMode, broker: BrokerId = 'delta'): ExchangeAdapter {
    const venue = this.v(broker)
    if (mode === 'paper') return venue.paperExchange
    const live = venue.liveExchange()
    if (!live) throw new UserError('not_configured', broker === 'delta' ? 'Delta Exchange API credentials are not configured.' : 'MetaTrader 5 is not set up (Settings → MetaTrader 5).')
    return live
  }

  // ---------- user controls ----------
  async start(strategyId: string, mode: AutomationMode, opts: StartOptions = {}): Promise<string> {
    const risk = this.risk()
    if (!risk.configured) throw new UserError('risk_not_configured', 'Configure the account risk settings before starting automated trading.')
    if (this.emergency().active) throw new UserError('emergency_active', 'The emergency stop is active. Clear it before starting automation.')
    const s = await this.d.strategy(strategyId)
    if (!s) throw new UserError('not_found', 'Strategy not found.')
    if (s.status !== 'enabled') throw new UserError('strategy_disabled', 'Only enabled (validated) strategies can be automated. Enable the strategy first.')
    if (!s.validation.valid) throw new UserError('strategy_invalid', `The strategy no longer passes validation: ${s.validation.errors[0]?.message}`)
    const broker = venueOf(s.definition)
    const venue = this.v(broker)
    if (mode === 'live') {
      if (!this.liveEnabled(broker).enabled) throw new UserError('live_disabled', `Live trading is turned off${broker === 'delta' ? '' : ' for MetaTrader 5'}. Enable it in the Live trading panel first.`)
      const failing = venue.liveChecks().filter((c) => !c.ok)
      if (failing.length) throw new UserError('live_checks_failed', failing.map((c) => c.detail).join(' '))
    }
    let guard: AccountIdentity | null = null
    if (mode === 'live' && venue.accountIdentity) {
      guard = await venue.accountIdentity()
      if (!guard) throw new UserError('account_unknown', 'The trading account could not be identified. Check the broker connection.')
      if (opts.requireAccount === 'demo' && guard.mode !== 'demo') throw new UserError('account_mode', `Demo mode only trades on a demo account, but account ${guard.login} is a ${guard.mode === 'real' ? 'REAL-MONEY' : guard.mode} account.`)
      if (opts.requireAccount === 'live' && guard.mode === 'demo') throw new UserError('account_mode', `Live mode is selected, but account ${guard.login} is a demo account. Switch to demo mode or log in to your live account.`)
    }
    const inst = await this.instrument(s.symbol, broker)
    if (mode === 'live') {
      const pos = await this.adapter('live', broker).position(inst.productId, s.symbol)
      if (pos && pos.size !== 0) throw new UserError('existing_position', `The exchange already shows an open ${s.symbol} position (${pos.size} ${inst.sizing.volumeUnit}). Close it or trade another instrument; TradePilot will not stack automation on a position it did not open.`)
    }
    const id = randomUUID()
    const iso = new Date(this.now()).toISOString()
    try {
      this.d.db.prepare(
        `INSERT INTO automation_sessions (id, strategy_id, strategy_name, symbol, product_id, timeframe, mode, status, started_at, created_at, updated_at, strategy_version, definition, broker, account_guard)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, s.id, s.name, s.symbol, inst.productId, s.timeframe!, mode, iso, iso, iso, s.version, JSON.stringify(s.definition), broker, guard ? JSON.stringify(guard) : null)
    } catch (err) {
      if (err instanceof Error && /UNIQUE/.test(err.message)) {
        throw new UserError('already_running', /symbol/.test(err.message) ? `Another live automation already trades ${s.symbol}.` : 'This strategy already has an active automation.')
      }
      throw err
    }
    // evaluate from the next closed candle onwards; never act on a signal from before the start
    const step = TF_SECONDS[s.timeframe!]
    this.update(id, { last_candle: Math.floor(this.now() / 1000 / step) * step - step })
    audit(this.d.db, 'automation.started', { id, strategyId, mode, version: s.version, ...(broker === 'delta' ? {} : { broker }) })
    this.event(id, mode === 'live' ? 'warning' : 'info', `${mode === 'live' ? 'LIVE' : 'Paper (simulated)'} automation started for ${s.name} v${s.version} on ${s.symbol} ${s.timeframe}.`, mode === 'live' ? 'Live automation started' : undefined)
    this.refreshWatch()
    this.d.onChange()
    return id
  }

  pause(id: string): void {
    const s = this.row(id)
    if (s.status !== 'running') throw new UserError('bad_state', 'Only running automations can be paused.')
    this.setStatus(id, 'paused', 'paused by you (no new entries; open positions keep their stop-loss and take-profit)')
    this.d.onChange()
  }

  async resume(id: string): Promise<void> {
    const s = this.row(id)
    if (s.status !== 'paused') throw new UserError('bad_state', 'Only paused automations can be resumed.')
    if (this.emergency().active) throw new UserError('emergency_active', 'Clear the emergency stop first.')
    if (s.mode === 'live' && !this.liveEnabled(s.broker).enabled) throw new UserError('live_disabled', 'Live trading is turned off.')
    const strat = s.strategy_id ? await this.d.strategy(s.strategy_id) : null
    if (!strat || strat.status !== 'enabled' || !strat.validation.valid) throw new UserError('strategy_invalid', 'The strategy is no longer enabled and valid; stop this automation.')
    this.setStatus(id, 'running', 'resumed by you')
    this.d.onChange()
  }

  /** Closes an automation's open position now; the automation keeps running. */
  async closePosition(id: string, reason = 'closed_by_user'): Promise<void> {
    const s = this.row(id)
    if (!this.position(s)) throw new UserError('no_position', 'This automation has no open position.')
    if (this.busy.has(id)) throw new UserError('busy', 'The automation is processing a candle. Try again in a moment.')
    this.busy.add(id)
    try {
      await this.executeExit(s, reason, 'exit')
    } finally {
      this.busy.delete(id)
    }
    this.d.onChange()
  }

  /** Records stop-loss / take-profit levels that were just changed at the broker for this automation's position. */
  setProtection(id: string, stopPrice: number | null, takePrice: number | null): void {
    const s = this.row(id)
    const pos = this.position(s)
    if (!pos) throw new UserError('no_position', 'This automation has no open position.')
    this.update(id, { position: JSON.stringify({ ...pos, stopPrice, takePrice }) })
    this.event(id, 'info', `Stop-loss ${stopPrice ?? 'none'} / take-profit ${takePrice ?? 'none'} set on the ${s.symbol} position by you.`)
    this.d.onChange()
  }

  /** The automation whose open position has this broker ticket (MT5). */
  sessionForTicket(ticket: number): { id: string; mode: AutomationMode; strategyId: string | null } | null {
    for (const s of this.rows('position IS NOT NULL')) {
      if (this.position(s)?.ticket === ticket) return { id: s.id, mode: s.mode, strategyId: s.strategy_id }
    }
    return null
  }

  async stop(id: string, closePosition: boolean): Promise<void> {
    const s = this.row(id)
    if (s.status === 'stopped' && !this.position(s)) throw new UserError('bad_state', 'This automation is already stopped.')
    if (closePosition && this.position(s)) await this.executeExit(s, 'stopped_by_user', 'exit')
    this.setStatus(id, 'stopped', closePosition ? 'stopped by you; position closed' : 'stopped by you')
    this.refreshWatch()
    this.d.onChange()
  }

  /**
   * Switches a session to the strategy's latest saved version. Only allowed with no open
   * position, so an existing position is never managed by rules it was not opened under.
   */
  async applyLatestVersion(id: string): Promise<void> {
    const s = this.row(id)
    if (s.status === 'stopped') throw new UserError('bad_state', 'This automation is stopped. Start a new one to use the latest version.')
    if (this.position(s)) throw new UserError('position_open', `An open position was opened under version ${s.strategy_version ?? '?'}; it keeps those rules. Apply the new version after it closes, or stop the automation.`)
    if (this.d.db.prepare(`SELECT 1 FROM auto_orders WHERE session_id = ? AND state IN ('pending', 'unknown', 'open', 'partially_filled')`).get(id)) throw new UserError('orders_pending', 'An order for this automation is still being confirmed. Try again in a moment.')
    const strat = s.strategy_id ? await this.d.strategy(s.strategy_id) : null
    if (!strat) throw new UserError('not_found', 'The strategy no longer exists.')
    if (strat.version === s.strategy_version) throw new UserError('bad_state', `This automation already runs version ${strat.version}.`)
    if (strat.status !== 'enabled' || !strat.validation.valid) throw new UserError('strategy_invalid', 'The latest version is not enabled and valid.')
    if (strat.symbol !== s.symbol || strat.timeframe !== s.timeframe) throw new UserError('bad_state', 'The new version changes the instrument or timeframe. Stop this automation and start a new one.')
    if (s.mode === 'live' && !this.liveEnabled(s.broker).enabled) throw new UserError('live_disabled', 'Live trading is turned off.')
    this.update(id, { strategy_version: strat.version, definition: JSON.stringify(strat.definition), strategy_name: strat.name })
    audit(this.d.db, 'automation.version_applied', { id, from: s.strategy_version, to: strat.version })
    this.event(id, 'info', `Now running ${strat.name} version ${strat.version} (was version ${s.strategy_version ?? '?'}); applied by you with no open position.`)
    this.d.onChange()
  }

  /**
   * Emergency stop: no new orders anywhere, every automation stopped, working entry orders
   * cancelled; positions are closed or left with their exchange-side protection per settings.
   */
  async emergencyStop(): Promise<void> {
    const action = this.risk().emergencyAction
    setSetting(this.d.db, 'trading.emergency', { active: true, at: new Date(this.now()).toISOString(), detail: action === 'close_positions' ? 'Positions closed' : 'Positions kept with their stop-loss / take-profit' })
    audit(this.d.db, 'trading.emergency_stop', { action })
    this.event(null, 'error', `EMERGENCY STOP: all automation stopped; ${action === 'close_positions' ? 'closing open positions' : 'keeping open positions with their protective orders'}.`, 'Emergency stop')
    const problems: string[] = []
    for (const s of this.rows("status != 'stopped' OR position IS NOT NULL")) {
      try {
        if (s.status !== 'stopped') this.setStatus(s.id, 'stopped', 'emergency stop')
        const ex = this.adapter(s.mode, s.broker)
        await ex.cancelAll(s.product_id, action === 'close_positions', s.symbol)
        if (action === 'close_positions' && this.position(this.row(s.id))) await this.executeExit(this.row(s.id), 'emergency_stop', 'emergency')
      } catch (err) {
        problems.push(`${s.strategy_name}: ${err instanceof Error ? err.message : err}`)
        this.event(s.id, 'error', `Emergency handling failed: ${err instanceof Error ? err.message : err}. Check the position on ${BROKER_LABEL[s.broker]}.`, 'Emergency stop problem')
      }
    }
    this.refreshWatch()
    this.d.onChange()
    if (problems.length) throw new UserError('emergency_partial', `Emergency stop is active, but ${problems.length} position(s) need attention: ${problems.join('; ')}`)
  }

  clearEmergency(): void {
    setSetting(this.d.db, 'trading.emergency', { active: false, at: null, detail: null })
    audit(this.d.db, 'trading.emergency_cleared')
    this.event(null, 'info', 'Emergency stop cleared. Automations stay stopped until you start them again.')
    this.d.onChange()
  }

  // ---------- scheduler ----------
  startScheduler(): void {
    if (this.timer) return
    this.refreshWatch()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private refreshWatch() {
    const active = this.rows("status != 'stopped' OR position IS NOT NULL")
    this.d.watchSymbols([...new Set(active.filter((s) => s.broker === 'delta').map((s) => s.symbol))])
    for (const [broker, venue] of Object.entries(this.d.venues ?? {}) as [BrokerId, VenueDeps][]) {
      venue.watchSymbols([...new Set(active.filter((s) => s.broker === broker).map((s) => s.symbol))])
    }
  }

  async tick(): Promise<void> {
    const now = this.now()
    if (now - this.lastReconcile >= RECONCILE_MS) {
      this.lastReconcile = now
      await this.reconcile().catch((err) => {
        this.lastExchangeError = redact(err instanceof Error ? err.message : String(err))
      })
    }
    for (const s of this.rows("status != 'stopped' OR position IS NOT NULL")) {
      if (this.busy.has(s.id)) continue
      this.busy.add(s.id)
      try {
        await this.process(s)
      } catch (err) {
        this.event(s.id, 'error', `Automation error: ${err instanceof Error ? err.message : err}`)
      } finally {
        this.busy.delete(s.id)
      }
    }
    this.d.onChange()
  }

  private async rolloverDay(s: SessionRow): Promise<SessionRow> {
    const key = dayKey(this.now())
    if (s.day_key === key) return s
    const equity = s.mode === 'paper' ? this.paperEquity() : (await this.v(s.broker).liveAccount()).equity
    this.update(s.id, { day_key: key, day_trades: 0, day_realized_pnl: 0, day_start_equity: equity })
    return this.row(s.id)
  }

  private async process(initial: SessionRow): Promise<void> {
    let s = await this.rolloverDay(initial)
    const pos = this.position(s)
    // paper positions: stop-loss / take-profit monitored on every tick (live ones sit on the exchange)
    if (pos && s.mode === 'paper') {
      const venue = this.v(s.broker)
      // with a bid/ask, a long closes at the bid and a short at the ask (as at the broker)
      const q = venue.quote ? await venue.quote(s.symbol) : null
      const mark = q ? (pos.side === 'long' ? q.bid : q.ask) : await venue.markPrice(s.symbol)
      const sign = pos.side === 'long' ? 1 : -1
      if (pos.stopPrice !== null && sign * (mark - pos.stopPrice) <= 0) return void (await this.executeExit(s, 'stop_loss', 'exit'))
      if (pos.takePrice !== null && sign * (mark - pos.takePrice) >= 0) return void (await this.executeExit(s, 'take_profit', 'exit'))
    }
    if (s.status === 'stopped') return
    const step = TF_SECONDS[s.timeframe]
    const nowSec = this.now() / 1000
    const currentStart = Math.floor(nowSec / step) * step
    const lastClosed = currentStart - step
    if ((s.last_candle ?? 0) >= lastClosed || nowSec < currentStart + CANDLE_GRACE_SEC) return
    s = this.row(s.id)
    await this.evaluate(s, lastClosed)
  }

  paperEquity(): number {
    const pnl = (this.d.db.prepare(`SELECT COALESCE(SUM(net_pnl), 0) AS p FROM auto_trades WHERE mode = 'paper'`).get() as { p: number }).p
    return this.risk().paperStartingEquity + pnl
  }

  /**
   * Account-wide figures for the risk checks. Live accounts are per broker (each has its own
   * equity and currency); the paper account is shared.
   */
  private async accountState(mode: AutomationMode, excludeSession: string, broker: BrokerId = 'delta') {
    const equity = mode === 'paper' ? this.paperEquity() : (await this.v(broker).liveAccount()).equity
    const others = mode === 'paper'
      ? this.rows('mode = ? AND position IS NOT NULL AND id != ?', mode, excludeSession)
      : this.rows('mode = ? AND broker = ? AND position IS NOT NULL AND id != ?', mode, broker, excludeSession)
    let exposure = 0
    let extraCount = 0
    for (const o of others) {
      const p = this.position(o)!
      const mark = await this.v(o.broker).markPrice(o.symbol).catch(() => p.entryPrice)
      exposure += p.contracts * p.contractValue * mark
    }
    const extra = mode === 'live' ? this.v(broker).extraOpen : undefined
    if (extra) {
      // manual trades count toward the same open-position and exposure limits
      const x = await extra()
      exposure += x.exposure
      extraCount = x.count
    }
    const day = dayKey(this.now())
    const realized = (mode === 'paper' || broker === 'delta'
      ? this.d.db.prepare(`SELECT COALESCE(SUM(net_pnl), 0) AS p FROM auto_trades WHERE mode = ? AND substr(exit_time, 1, 10) = ?${mode === 'live' ? ` AND broker = 'delta'` : ''}`).get(mode, day)
      : this.d.db.prepare(`SELECT COALESCE(SUM(net_pnl), 0) AS p FROM auto_trades WHERE mode = ? AND broker = ? AND substr(exit_time, 1, 10) = ?`).get(mode, broker, day)) as { p: number }
    const startKey = mode === 'live' && broker !== 'delta' ? `trading.daystart.live.${broker}` : `trading.daystart.${mode}`
    let start = getSetting<{ day: string; equity: number } | null>(this.d.db, startKey, null)
    if (!start || start.day !== day) {
      start = { day, equity: equity - realized.p }
      setSetting(this.d.db, startKey, start)
    }
    return { equity, openExposureUsd: exposure, openPositions: others.length + extraCount, dayStartEquity: start.equity, dayRealizedPnl: realized.p }
  }

  /** Losing trades in a row today (UTC) and when the last trade closed, for loss-streak and cooldown limits. */
  streakState(sessionId: string): { consecutiveLosses: number; lastExitTime: string | null } {
    const rows = this.d.db.prepare('SELECT net_pnl, exit_time FROM auto_trades WHERE session_id = ? ORDER BY exit_time DESC LIMIT 100').all(sessionId) as { net_pnl: number; exit_time: string }[]
    const today = dayKey(this.now())
    let losses = 0
    for (const r of rows) {
      if (r.exit_time.slice(0, 10) !== today || r.net_pnl > 0) break
      losses++
    }
    return { consecutiveLosses: losses, lastExitTime: rows[0]?.exit_time ?? null }
  }

  /** The pinned version this session runs (never the strategy's newer edits). */
  private pinned(s: SessionRow, strat: Strategy): StrategyDefinition {
    return s.definition ? (JSON.parse(s.definition) as StrategyDefinition) : strat.definition
  }

  private async evaluate(s: SessionRow, lastClosed: number): Promise<void> {
    const strat = s.strategy_id ? await this.d.strategy(s.strategy_id) : null
    const definition = strat ? this.pinned(s, strat) : null
    const snapshotValid = definition && this.d.validate ? (await this.d.validate(definition)).valid : true
    if (!strat || !definition || strat.status !== 'enabled' || !strat.validation.valid || !snapshotValid) {
      if (s.status === 'running') {
        this.setStatus(s.id, 'paused', 'the strategy is no longer enabled and valid')
        this.event(s.id, 'warning', 'Automation paused because its strategy is no longer enabled and valid.', 'Automation paused')
      }
      return
    }
    const venue = this.v(s.broker)
    const step = TF_SECONDS[s.timeframe]
    if (venue.isMarketOpen && !(await venue.isMarketOpen(s.symbol))) {
      // forex/CFD sessions close (weekends, breaks): skip quietly, no orders and no warnings
      const at = new Date(this.now()).toISOString()
      this.update(s.id, { last_candle: lastClosed, last_evaluated_at: at, last_decision: JSON.stringify({ action: 'none', reason: 'market closed', blockedBy: [], at }) })
      return
    }
    // higher-timeframe indicators (an M15 trend on M1 candles) need a longer history
    const lookback = Math.max(LOOKBACK, requiredBars(definition))
    const days = Math.min(MAX_BACKTEST_DAYS[s.timeframe], Math.ceil(((lookback + 5) * step) / 86400) + 1)
    const all = await venue.candles(s.symbol, s.timeframe, days)
    const closed = all.filter((c) => c.time <= lastClosed).slice(-lookback)
    if (closed.at(-1)?.time !== lastClosed) {
      // the exchange has not published the candle yet; give up on it after a minute
      if (this.now() / 1000 > lastClosed + step + 60) {
        this.update(s.id, { last_candle: lastClosed })
        this.event(s.id, 'warning', `No ${s.timeframe} candle data for ${new Date(lastClosed * 1000).toISOString().slice(0, 16)} UTC; that candle was skipped.`)
      }
      return
    }
    const inst = await this.instrument(s.symbol, s.broker)
    const mark = await venue.markPrice(s.symbol)
    const q = venue.quote ? await venue.quote(s.symbol).catch(() => null) : null
    const account = await this.accountState(s.mode, s.id, s.broker)
    const params = {
      definition,
      risk: this.risk(),
      candles: closed,
      session: {
        status: s.status,
        position: this.position(s),
        dayTrades: s.day_trades,
        dayRealizedPnl: s.day_realized_pnl,
        dayStartEquity: s.day_start_equity ?? account.equity,
        lastSignalCandle: s.last_signal_candle,
        entriesAllowed: !s.entries_blocked_reason,
        entriesBlockedReason: s.entries_blocked_reason,
        // only strategies with these limits get the fields (other engine inputs are unchanged)
        ...(definition.risk.maxConsecutiveLosses || definition.risk.cooldownBars ? this.streakState(s.id) : {})
      },
      account,
      // contractValue kept for older engines; the sizing spec is authoritative
      instrument: { contractValue: inst.sizing.valuePerPoint, tickSize: inst.tickSize, ...inst.sizing, ...(inst.pipSize ? { pipSize: inst.pipSize } : {}) },
      quote: q ? { mark, bid: q.bid, ask: q.ask } : { mark },
      emergency: this.emergency().active || (s.mode === 'live' && !this.liveEnabled(s.broker).enabled)
    }
    let decision: EngineDecision
    try {
      decision = await this.d.engine<EngineDecision>('session_evaluate', params)
    } catch (err) {
      this.update(s.id, { last_candle: lastClosed, last_evaluated_at: new Date(this.now()).toISOString(), last_decision: JSON.stringify({ action: 'none', reason: `engine error: ${err instanceof Error ? err.message : err}`, blockedBy: [], at: new Date(this.now()).toISOString() }) })
      this.event(s.id, 'error', `Engine could not evaluate the strategy: ${err instanceof Error ? err.message : err}`)
      return
    }
    const at = new Date(this.now()).toISOString()
    this.update(s.id, { last_candle: lastClosed, last_evaluated_at: at, last_decision: JSON.stringify({ action: decision.intent.action, reason: decision.intent.reason, blockedBy: decision.blockedBy, at }) })
    if (decision.blockedBy.length) this.event(s.id, 'info', `Entry signal blocked: ${decision.blockedBy.join('; ')}.`)
    if (decision.intent.action === 'open_long' || decision.intent.action === 'open_short') {
      await this.executeEntry(this.row(s.id), decision, definition, inst)
    } else if (decision.intent.action === 'close') {
      await this.executeExit(this.row(s.id), decision.intent.reason, 'exit')
    }
  }

  // ---------- execution ----------
  private insertOrder(o: { session: SessionRow; clientOrderId: string; side: 'buy' | 'sell'; purpose: 'entry' | 'exit' | 'emergency'; signalKey: string; size: number; stop?: number | null; take?: number | null }): string {
    const id = randomUUID()
    const iso = new Date(this.now()).toISOString()
    this.d.db.prepare(
      `INSERT INTO auto_orders (id, session_id, mode, client_order_id, symbol, side, purpose, signal_key, size, state, stop_price, take_price, created_at, updated_at, broker)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
    ).run(id, o.session.id, o.session.mode, o.clientOrderId, o.session.symbol, o.side, o.purpose, o.signalKey, o.size, o.stop ?? null, o.take ?? null, iso, iso, o.session.broker)
    return id
  }

  private recordResult(orderId: string, r: OrderResult | null, error?: string, state?: OrderState): void {
    const iso = new Date(this.now()).toISOString()
    if (!r) {
      this.d.db.prepare('UPDATE auto_orders SET state = ?, error = ?, updated_at = ? WHERE id = ?').run(state ?? 'unknown', error ? redact(error).slice(0, 500) : null, iso, orderId)
      return
    }
    this.d.db.prepare('UPDATE auto_orders SET exchange_order_id = ?, state = ?, filled_size = ?, avg_fill_price = ?, fee = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(r.exchangeOrderId, r.state, r.filled, r.avgPrice, r.fee, r.note ?? error ?? null, iso, orderId)
  }

  /** Market orders should fill immediately; poll briefly, then cancel any unfilled remainder. */
  private async settle(ex: ExchangeAdapter, clientOrderId: string, first: OrderResult, productId: number): Promise<OrderResult> {
    let r = first
    for (let i = 0; i < 5 && (r.state === 'open' || r.state === 'pending' || (r.state === 'partially_filled' && r.filled < r.size)); i++) {
      await this.sleep(1000)
      r = (await ex.orderByClientId(clientOrderId)) ?? r
      if (r.state === 'filled' || r.state === 'cancelled') return r
    }
    if ((r.state === 'open' || r.state === 'partially_filled') && r.exchangeOrderId && r.filled < r.size) {
      await ex.cancel(r.exchangeOrderId, productId).catch(() => undefined)
      r = (await ex.orderByClientId(clientOrderId)) ?? r
    }
    return r
  }

  /**
   * Live sessions with an account guard trade only on the account they were started on: a terminal
   * that was switched to another login, or from a demo to a real account, never receives orders.
   */
  private async accountProblem(s: SessionRow): Promise<string | null> {
    if (s.mode !== 'live' || !s.account_guard) return null
    const venue = this.v(s.broker)
    if (!venue.accountIdentity) return null
    const g = JSON.parse(s.account_guard) as AccountIdentity
    const now = await venue.accountIdentity().catch(() => null)
    if (!now) return 'the trading account could not be identified'
    if (now.login !== g.login) return `the terminal is now logged in to account ${now.login}, not account ${g.login} this automation was started on`
    if (now.mode !== g.mode) return `account ${now.login} is now reported as a ${now.mode} account, not ${g.mode}`
    return null
  }

  private async pauseForAccount(s: SessionRow, why: string): Promise<void> {
    if (this.row(s.id).status === 'running') this.setStatus(s.id, 'paused', 'trading account changed')
    this.event(s.id, 'error', `No order sent: ${why}. The automation was paused; positions on the original account keep their stop-loss / take-profit at the broker.`, 'Trading account changed')
  }

  private async executeEntry(s: SessionRow, dec: EngineDecision, def: StrategyDefinition, inst: Instrument & { sizing: SizingSpec }): Promise<void> {
    const it = dec.intent
    const side = it.action === 'open_long' ? 'buy' : 'sell'
    const contracts = it.contracts ?? 0
    const risk = this.risk()
    // independent gate: the engine's answer is re-checked before anything is sent
    const refuse = (why: string) => {
      this.event(s.id, 'warning', `Order not sent: ${why}.`)
      return undefined
    }
    if (this.emergency().active) return refuse('the emergency stop is active')
    if (s.status !== 'running') return refuse('the automation is not running')
    if (s.mode === 'live' && !this.liveEnabled(s.broker).enabled) return refuse('live trading is turned off')
    if (!isValidVolume(contracts, inst.sizing)) return refuse('invalid order size from the engine')
    const notional = contracts * inst.sizing.valuePerPoint * (it.estPrice ?? 0)
    if (!(notional > 0) || notional > risk.maxOrderNotionalUsd * 1.001) return refuse(`order notional ${notional.toFixed(2)} exceeds the ${risk.maxOrderNotionalUsd} limit`)
    if (s.last_signal_candle === dec.candleTime) return refuse('this signal was already handled')
    if (this.position(s)) return refuse('a position is already open')
    if (it.stopPrice === null || it.stopPrice === undefined) return refuse('no stop-loss price')
    const ex = this.adapter(s.mode, s.broker)
    if (s.mode === 'live') {
      const wrongAccount = await this.accountProblem(s)
      if (wrongAccount) return void (await this.pauseForAccount(s, wrongAccount))
      const pos = await ex.position(s.product_id, s.symbol)
      if (pos && pos.size !== 0) {
        this.update(s.id, { entries_blocked_reason: 'the exchange shows a position this automation did not open' })
        return refuse(`the exchange already shows ${pos.size} ${inst.sizing.volumeUnit} open`)
      }
    }

    const signalKey = `${s.id}:${dec.candleTime}:${it.action}`
    const clientOrderId = cid('e', signalKey)
    let orderId: string
    try {
      orderId = transaction(this.d.db, () => {
        const id = this.insertOrder({ session: s, clientOrderId, side, purpose: 'entry', signalKey, size: contracts, stop: it.stopPrice, take: it.takePrice })
        // remembered before sending, so a crash or restart can never re-send this signal
        this.update(s.id, { last_signal_candle: dec.candleTime })
        return id
      })
    } catch (err) {
      if (err instanceof Error && /UNIQUE/.test(err.message)) return refuse('duplicate signal (an order already exists for it)')
      throw err
    }
    this.event(s.id, 'info', `${s.mode === 'live' ? 'Sending' : 'Simulating'} ${side} ${contracts} ${s.symbol} (${it.reason}; est. ${it.estPrice}, stop ${it.stopPrice}${it.takePrice ? `, target ${it.takePrice}` : ''}).${it.notes?.length ? ` ${it.notes.join('. ')}.` : ''}`)

    let r: OrderResult
    try {
      r = await ex.placeMarket({ productId: s.product_id, symbol: s.symbol, side, size: contracts, clientOrderId, reduceOnly: false, stopPrice: it.stopPrice, takePrice: it.takePrice ?? null, tickSize: inst.tickSize })
      r = await this.settle(ex, clientOrderId, r, s.product_id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const definitive = err instanceof ProviderError && ['invalid_request', 'auth', 'permission', 'region_blocked', 'not_found'].includes(err.kind)
      // timeouts / network: the order may or may not exist; reconciliation looks it up by client id
      this.recordResult(orderId, null, msg, definitive ? 'rejected' : 'unknown')
      this.event(s.id, definitive ? 'error' : 'warning', definitive ? `Order rejected: ${msg}` : `Order status unknown (${msg}); checking with the exchange.`, definitive ? 'Order rejected' : undefined)
      return
    }
    this.recordResult(orderId, r)
    if (r.filled > 0 && r.avgPrice) {
      this.openPosition(s, side === 'buy' ? 'long' : 'short', r.filled, r.avgPrice, r.fee, it.stopPrice ?? null, it.takePrice ?? null, inst.sizing.valuePerPoint, r.positionTicket)
      const note = r.state === 'partially_filled' ? ` (partial fill: ${r.filled} of ${r.size})` : ''
      this.event(s.id, 'info', `${s.mode === 'live' ? 'Filled' : 'Simulated fill'}: ${side} ${r.filled} ${s.symbol} at ${r.avgPrice}${note}; fee ${r.fee.toFixed(4)}.`, `${s.mode === 'live' ? 'Order filled' : 'Paper order filled'}: ${s.symbol}`)
    } else {
      this.event(s.id, 'warning', `Order ${r.state}: nothing was filled${r.note ? ` (${r.note})` : ''}.`, `Order ${r.state}`)
    }
    void def
  }

  private openPosition(s: SessionRow, side: 'long' | 'short', contracts: number, price: number, fee: number, stop: number | null, take: number | null, contractValue: number, ticket?: number | null) {
    const pos: AutoPosition = { side, contracts, contractValue, entryPrice: price, entryTime: new Date(this.now()).toISOString(), stopPrice: stop, takePrice: take, entryFee: fee, ...(ticket ? { ticket } : {}) }
    const cur = this.row(s.id)
    this.update(s.id, { position: JSON.stringify(pos), day_trades: cur.day_trades + 1 })
  }

  /** Closes the session's position with a reduce-only market order (retried a few times: leaving risk open is worse). */
  private async executeExit(s: SessionRow, reason: string, purpose: 'exit' | 'emergency'): Promise<void> {
    const pos = this.position(s)
    if (!pos) return
    const wrongAccount = await this.accountProblem(s)
    if (wrongAccount) {
      // closing on another account could close someone else's position
      await this.pauseForAccount(s, wrongAccount)
      throw new UserError('account_changed', `The ${s.symbol} position was not closed: ${wrongAccount}.`)
    }
    const ex = this.adapter(s.mode, s.broker)
    const inst = await this.instrument(s.symbol, s.broker)
    for (let attempt = 1; attempt <= 3; attempt++) {
      let size = pos.contracts
      if (s.mode === 'live') {
        const live = await ex.position(s.product_id, s.symbol)
        if (live && live.size === 0) return void (await this.recordExternalClose(s, pos))
        // Delta: close what the exchange holds. MT5 netting accounts may include manual volume,
        // so never close more than this automation opened.
        if (live) size = s.broker === 'delta' ? Math.abs(live.size) : Math.min(Math.abs(live.size), pos.contracts)
      }
      const side = pos.side === 'long' ? 'sell' : 'buy'
      const clientOrderId = cid('x', `${s.id}:${pos.entryTime}:${reason}:${attempt}`)
      const orderId = this.insertOrder({ session: s, clientOrderId, side, purpose, signalKey: `${s.id}:exit:${pos.entryTime}:${attempt}`, size })
      try {
        let r = await ex.placeMarket({ productId: s.product_id, symbol: s.symbol, side, size, clientOrderId, reduceOnly: true, tickSize: inst.tickSize, positionTicket: pos.ticket ?? null })
        r = await this.settle(ex, clientOrderId, r, s.product_id)
        this.recordResult(orderId, r)
        if (r.filled > 0 && r.avgPrice) {
          this.closeTrade(s, pos, r.avgPrice, r.fee, reason, r.filled)
          if (s.mode === 'live') await ex.cancelAll(s.product_id, true, s.symbol).catch(() => undefined) // leftover bracket legs
          return
        }
        this.event(s.id, 'warning', `Exit order ${r.state} without a fill (attempt ${attempt}).`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.recordResult(orderId, null, msg, err instanceof ProviderError && err.kind === 'invalid_request' ? 'rejected' : 'unknown')
        this.event(s.id, 'error', `Exit attempt ${attempt} failed: ${msg}`)
      }
      await this.sleep(2000 * attempt)
    }
    this.event(s.id, 'error', `Could not close the ${s.symbol} position after 3 attempts. Check it on ${BROKER_LABEL[s.broker]} now.`, 'Position could not be closed')
  }

  private closeTrade(s: SessionRow, pos: AutoPosition, exitPrice: number, exitFee: number, reason: string, filled = pos.contracts) {
    const sign = pos.side === 'long' ? 1 : -1
    const gross = sign * (exitPrice - pos.entryPrice) * filled * pos.contractValue
    const fees = pos.entryFee * (filled / pos.contracts) + exitFee
    const net = gross - fees
    const iso = new Date(this.now()).toISOString()
    transaction(this.d.db, () => {
      this.d.db.prepare(
        `INSERT INTO auto_trades (id, session_id, mode, symbol, side, contracts, contract_value, entry_price, exit_price, entry_time, exit_time, gross_pnl, fees, net_pnl, exit_reason, created_at, strategy_version, broker)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), s.id, s.mode, s.symbol, pos.side, filled, pos.contractValue, pos.entryPrice, exitPrice, pos.entryTime, iso, gross, fees, net, reason, iso, this.row(s.id).strategy_version, s.broker)
      const cur = this.row(s.id)
      // fractional volumes: a full close must not leave float dust behind as an open position
      const remaining = sameVolume(pos.contracts, filled) ? 0 : pos.contracts - filled
      this.update(s.id, { position: remaining > 0 ? JSON.stringify({ ...pos, contracts: remaining, entryFee: pos.entryFee * (remaining / pos.contracts) }) : null, day_realized_pnl: cur.day_realized_pnl + net })
    })
    this.event(s.id, net >= 0 ? 'info' : 'warning', `Closed ${pos.side} ${filled} ${s.symbol} at ${exitPrice} (${reason.replace(/_/g, ' ')}): ${net >= 0 ? '+' : ''}${net.toFixed(2)} after ${fees.toFixed(4)} fees.`, `${s.mode === 'live' ? 'Trade closed' : 'Paper trade closed'}: ${s.symbol}`)
  }

  /** The exchange closed the position (bracket stop/target, manual or liquidation): record it from the fills. */
  private async recordExternalClose(s: SessionRow, pos: AutoPosition) {
    const ex = this.adapter(s.mode, s.broker)
    const exitSide = pos.side === 'long' ? 'sell' : 'buy'
    const fills = (await ex.fillsSince(s.product_id, Date.parse(pos.entryTime), s.symbol, pos.ticket ?? null)).filter((f) => f.side === exitSide)
    const size = fills.reduce((a, f) => a + f.size, 0)
    if (size <= 0) {
      this.update(s.id, { position: null })
      this.event(s.id, 'warning', `The ${s.symbol} position is no longer open on the exchange, but no closing fills were found. Check the account history on ${BROKER_LABEL[s.broker]}.`, 'Position closed outside TradePilot')
      return
    }
    const price = fills.reduce((a, f) => a + f.price * f.size, 0) / size
    const fee = fills.reduce((a, f) => a + f.fee, 0)
    const reason = pos.stopPrice !== null && (pos.side === 'long' ? price <= pos.stopPrice * 1.002 : price >= pos.stopPrice * 0.998) ? 'stop_loss_on_exchange' : pos.takePrice !== null && (pos.side === 'long' ? price >= pos.takePrice * 0.998 : price <= pos.takePrice * 1.002) ? 'take_profit_on_exchange' : 'closed_on_exchange'
    this.closeTrade(s, pos, price, fee, reason, Math.min(size, pos.contracts))
    if (size < pos.contracts) this.update(s.id, { position: null })
  }

  /** Brings local records in line with the exchange (live sessions only). */
  async reconcile(): Promise<void> {
    const brokers: BrokerId[] = ['delta', ...(Object.keys(this.d.venues ?? {}) as BrokerId[])]
    const problems: string[] = []
    for (const broker of brokers) {
      // each broker separately: an offline MT5 terminal must not stop Delta reconciliation
      try {
        await this.reconcileBroker(broker)
      } catch (err) {
        problems.push(`${broker === 'delta' ? 'Delta Exchange' : 'MetaTrader 5'}: ${err instanceof Error ? err.message : err}`)
      }
    }
    if (problems.length) throw new Error(problems.join(' · '))
    this.lastReconcileAt = new Date(this.now()).toISOString()
    this.lastExchangeError = null
  }

  private async reconcileBroker(broker: BrokerId): Promise<void> {
    const live = this.rows("mode = 'live' AND broker = ? AND (status != 'stopped' OR position IS NOT NULL)", broker)
    const pendingOrders = this.d.db.prepare(`SELECT id, client_order_id, session_id, created_at FROM auto_orders WHERE mode = 'live' AND broker = ? AND state IN ('pending', 'unknown', 'open')`).all(broker) as { id: string; client_order_id: string; session_id: string; created_at: string }[]
    if (!live.length && !pendingOrders.length) return
    const ex = this.v(broker).liveExchange()
    if (!ex) return
    for (const o of pendingOrders) {
      const r = await ex.orderByClientId(o.client_order_id)
      if (r) {
        this.recordResult(o.id, r)
        const s = this.row(o.session_id)
        if (r.filled > 0 && r.avgPrice && !this.position(s)) {
          const order = this.d.db.prepare('SELECT side, purpose, stop_price, take_price FROM auto_orders WHERE id = ?').get(o.id) as { side: 'buy' | 'sell'; purpose: string; stop_price: number | null; take_price: number | null }
          if (order.purpose === 'entry') {
            const inst = await this.instrument(s.symbol, s.broker)
            this.openPosition(s, order.side === 'buy' ? 'long' : 'short', r.filled, r.avgPrice, r.fee, order.stop_price, order.take_price, inst.sizing.valuePerPoint, r.positionTicket)
            this.event(s.id, 'info', `Reconciled: order ${o.client_order_id} was filled on the exchange (${r.filled} at ${r.avgPrice}).`)
          }
        }
      } else if (this.now() - Date.parse(o.created_at) > UNKNOWN_ORDER_GIVE_UP_MS) {
        this.recordResult(o.id, null, 'The exchange has no record of this order; it was not placed.', 'rejected')
        this.event(o.session_id, 'warning', `Order ${o.client_order_id} was never received by the exchange.`)
      }
    }
    for (const s of live) {
      const pos = this.position(s)
      const ex2 = await ex.position(s.product_id, s.symbol)
      if (!ex2) continue
      const unit = broker === 'delta' ? 'contracts' : 'lots'
      if (pos && ex2.size === 0) await this.recordExternalClose(s, pos)
      else if (!pos && ex2.size !== 0 && !s.entries_blocked_reason) {
        this.update(s.id, { entries_blocked_reason: 'the exchange shows a position this automation did not open' })
        this.event(s.id, 'warning', `The exchange shows ${ex2.size} ${s.symbol} ${unit} that this automation did not open. New entries are blocked until it is closed.`, 'Untracked position')
      } else if (!pos && ex2.size === 0 && s.entries_blocked_reason?.startsWith('the exchange shows')) {
        this.update(s.id, { entries_blocked_reason: null })
        this.event(s.id, 'info', 'The untracked exchange position is gone; entries are allowed again.')
      } else if (
        pos &&
        !sameVolume(Math.abs(ex2.size), pos.contracts) &&
        Math.sign(ex2.size) === (pos.side === 'long' ? 1 : -1) &&
        // MT5 netting accounts also count manual volume: only shrink to what the broker holds
        (broker === 'delta' || Math.abs(ex2.size) < pos.contracts)
      ) {
        this.update(s.id, { position: JSON.stringify({ ...pos, contracts: Math.abs(ex2.size) }) })
        this.event(s.id, 'warning', `Position size corrected from ${pos.contracts} to ${Math.abs(ex2.size)} ${unit} to match the exchange.`)
      }
    }
  }

  // ---------- views ----------
  private sessionView(s: SessionRow, marks: Record<string, number | undefined>): AutomationSessionView {
    const pos = this.position(s)
    const mark = marks[s.symbol] ?? null
    const totals = this.d.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(net_pnl), 0) AS p, COALESCE(SUM(fees), 0) AS f FROM auto_trades WHERE session_id = ?').get(s.id) as { n: number; p: number; f: number }
    const step = TF_SECONDS[s.timeframe]
    const next = s.status === 'stopped' ? null : new Date(((s.last_candle ?? 0) + 2 * step + CANDLE_GRACE_SEC) * 1000).toISOString()
    return {
      id: s.id,
      broker: s.broker,
      strategyId: s.strategy_id,
      strategyName: s.strategy_name,
      symbol: s.symbol,
      timeframe: s.timeframe,
      mode: s.mode,
      status: s.status,
      startedAt: s.started_at,
      stoppedAt: s.stopped_at,
      stopReason: s.stop_reason,
      position: pos,
      markPrice: mark,
      unrealizedPnl: pos && mark !== null ? (pos.side === 'long' ? 1 : -1) * (mark - pos.entryPrice) * pos.contracts * pos.contractValue : null,
      today: { trades: s.day_key === dayKey(this.now()) ? s.day_trades : 0, realizedPnl: s.day_key === dayKey(this.now()) ? s.day_realized_pnl : 0 },
      totals: { trades: totals.n, netPnl: totals.p, fees: totals.f },
      lastEvaluatedAt: s.last_evaluated_at,
      lastCandle: s.last_candle,
      nextEvaluationAt: next,
      lastDecision: s.last_decision ? JSON.parse(s.last_decision) : null,
      warning: s.entries_blocked_reason,
      strategyVersion: s.strategy_version,
      latestVersion: s.strategy_id ? ((this.d.db.prepare('SELECT version FROM strategies WHERE id = ?').get(s.strategy_id) as { version: number } | undefined)?.version ?? null) : null
    }
  }

  private tradeViews(where: string, ...args: string[]): AutoTradeView[] {
    return (this.d.db.prepare(`SELECT * FROM auto_trades WHERE ${where} ORDER BY exit_time DESC LIMIT 100`).all(...args) as Record<string, unknown>[]).map(
      (t): AutoTradeView => ({
        id: String(t.id), broker: (t.broker as BrokerId) ?? 'delta', sessionId: String(t.session_id), mode: t.mode as AutomationMode, symbol: String(t.symbol), side: t.side as 'long', contracts: Number(t.contracts),
        entryPrice: Number(t.entry_price), exitPrice: Number(t.exit_price), entryTime: String(t.entry_time), exitTime: String(t.exit_time), grossPnl: Number(t.gross_pnl),
        fees: Number(t.fees), netPnl: Number(t.net_pnl), exitReason: String(t.exit_reason), strategyVersion: (t.strategy_version as number | null) ?? null
      })
    )
  }

  private eventViews(where: string, ...args: string[]): AutomationEventView[] {
    return (this.d.db.prepare(`SELECT * FROM automation_events WHERE ${where} ORDER BY id DESC LIMIT 100`).all(...args) as Record<string, unknown>[]).map(
      (e): AutomationEventView => ({ id: Number(e.id), sessionId: (e.session_id as string | null) ?? null, level: e.level as 'info', message: String(e.message), createdAt: String(e.created_at) })
    )
  }

  /** Sessions (paper and live), trades and recent signals/events of one strategy. */
  strategyActivity(strategyId: string, marks: Record<string, number | undefined>): StrategyActivity {
    const rows = this.rows('strategy_id = ?', strategyId).slice(0, 20)
    const ids = rows.map((r) => r.id)
    const inList = ids.length ? `session_id IN (${ids.map(() => '?').join(',')})` : '0'
    return { sessions: rows.map((r) => this.sessionView(r, marks)), trades: this.tradeViews(inList, ...ids), events: this.eventViews(inList, ...ids) }
  }

  /** `broker` selects whose live-trading state is shown (sessions, orders and trades cover all brokers). */
  async overview(marks: Record<string, number | undefined>, broker: BrokerId = 'delta'): Promise<TradingOverview> {
    const venue = this.d.venues?.[broker as Exclude<BrokerId, 'delta'>] ?? this.d
    const r = venue.region()
    const sessions: AutomationSessionView[] = this.rows("status != 'stopped' OR position IS NOT NULL OR stopped_at >= ?", new Date(this.now() - 7 * 86400_000).toISOString()).map((s) => this.sessionView(s, marks))
    const orders = (this.d.db.prepare('SELECT * FROM auto_orders ORDER BY created_at DESC LIMIT 100').all() as Record<string, unknown>[]).map(
      (o): AutoOrderView => ({
        id: String(o.id), broker: (o.broker as BrokerId | null) ?? 'delta', sessionId: String(o.session_id), mode: o.mode as AutomationMode, symbol: String(o.symbol), side: o.side as 'buy', purpose: o.purpose as 'entry',
        size: Number(o.size), filledSize: Number(o.filled_size), avgFillPrice: (o.avg_fill_price as number | null) ?? null, fee: Number(o.fee), state: o.state as OrderState,
        clientOrderId: String(o.client_order_id), exchangeOrderId: (o.exchange_order_id as string | null) ?? null, stopPrice: (o.stop_price as number | null) ?? null,
        takePrice: (o.take_price as number | null) ?? null, error: (o.error as string | null) ?? null, createdAt: String(o.created_at), updatedAt: String(o.updated_at)
      })
    )
    const trades = this.tradeViews('1=1')
    const events = this.eventViews('1=1')
    const live = this.liveEnabled(venue === this.d ? 'delta' : broker)
    const paperPnl = (this.d.db.prepare(`SELECT COALESCE(SUM(net_pnl), 0) AS p FROM auto_trades WHERE mode = 'paper'`).get() as { p: number }).p
    return {
      live: { broker: venue === this.d ? 'delta' : broker, enabled: live.enabled, enabledAt: live.enabledAt, region: r.id as never, regionLabel: r.label, testnet: r.testnet, checks: venue.liveChecks() },
      risk: this.risk(),
      emergency: this.emergency(),
      sessions,
      orders,
      trades,
      events,
      exchange: { lastReconcileAt: this.lastReconcileAt, lastError: this.lastExchangeError },
      paperAccount: { equity: this.risk().paperStartingEquity + paperPnl, realizedPnl: paperPnl }
    }
  }

  /** Tells the screens that trading state changed (e.g. after a manual order). */
  notifyChange(): void {
    this.d.onChange()
  }

  /** Live automations on a broker that are running or paused (they need its connection). */
  activeLiveCount(broker: BrokerId): number {
    return this.rows("mode = 'live' AND broker = ? AND status != 'stopped'", broker).length
  }

  activeSymbols(broker: BrokerId = 'delta'): string[] {
    return [...new Set(this.rows("(status != 'stopped' OR position IS NOT NULL) AND broker = ?", broker).map((s) => s.symbol))]
  }
}
