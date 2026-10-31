import { createHash, randomUUID } from 'node:crypto'
import { audit, getSetting, setSetting, type Db } from '../db.js'
import { UserError } from '../errors.js'
import { ProviderError } from '../net.js'
import type { Mt5Connection } from '../mt5/connection.js'
import type { Mt5Deal, Mt5Position } from '../mt5/client.js'
import type { Mt5MarketData } from '../mt5/marketData.js'
import { tradeModeOf } from '../mt5/account.js'
import type { StrategyStore } from '../strategies.js'
import type { AutomationService } from '../trading/automation.js'
import type { Mt5Exchange } from '../trading/mt5Exchange.js'
import type { OrderResult } from '../trading/exchange.js'
import { TF_SECONDS } from '../marketData.js'
import type { AutomationSessionView, Candle, GoldAnalysis, GoldManualOrderView, GoldPositionView, GoldSignalView, GoldStatus, Instrument, OrderState } from '../../shared/ipc.js'
import { detectGoldSymbols, goldDefinition, GOLD_STRATEGY_NAME, normalizeGoldSettings, validateGoldSettings, type GoldCandidate, type GoldSettings } from '../../shared/gold.js'
import { requiredBars } from '../../shared/strategyRules.js'
import type { CandleSeries, Timeframe } from '../../shared/ipc.js'
import { isValidVolume, roundVolumeDown, sizingSpecOf, type SizingSpec } from '../../shared/sizing.js'

const ANALYSIS_TTL_MS = 10_000
const SPEC_TTL_MS = 60_000
const STATS_TTL_MS = 15_000
const SCALP_EMAS = [9, 20, 50]
const CHART_DAYS: Record<'1m' | '5m' | '15m', number> = { '1m': 1, '5m': 3, '15m': 7 }
const STATS_DAYS = 30
const UNKNOWN_GIVE_UP_MS = 60_000

export interface GoldDeps {
  db: Db
  now?: () => number
  conn: Mt5Connection
  market: Mt5MarketData
  automation: AutomationService
  strategies: StrategyStore
  engine: <T>(method: string, params: unknown) => Promise<T>
  /** Exchange for manual orders (its own magic number). */
  manualExchange: () => Mt5Exchange
  botMagic: number
  manualMagic: number
  /** MT5 credentials are saved. */
  configured: () => boolean
  /** Called with the detected gold symbol so charts can default to it. */
  onSymbolDetected?: (symbol: string) => void
  onChange?: () => void
  log?: (msg: string) => void
}

interface ManualRow {
  id: string
  request_id: string
  client_order_id: string
  symbol: string
  side: 'buy' | 'sell'
  volume: number
  stop_price: number | null
  take_price: number | null
  state: OrderState
  filled: number
  avg_price: number | null
  fee: number
  exchange_order_id: string | null
  position_ticket: number | null
  account_login: string
  account_mode: 'demo' | 'contest' | 'real'
  error: string | null
  note: string | null
  created_at: string
}

interface EngineDecision {
  candleTime: number
  signals: Record<string, boolean>
  blockedBy: string[]
  intent: { action: string; reason: string; contracts?: number; estPrice?: number; stopPrice?: number | null; takePrice?: number | null }
}

const cid = (prefix: string, key: string) => `${prefix}${createHash('sha256').update(key).digest('hex').slice(0, 30)}`
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * The XAUUSD Gold Bot: one place that brings together the broker's gold symbol, live prices, the
 * account, the built-in strategy (an ordinary automation), manual orders and positions. Every
 * order path re-checks the connection, the account type, the "automatic trading" switch, the
 * spread and the risk limits; nothing is reported as executed unless MT5 confirms it.
 */
export class GoldService {
  private readonly now: () => number
  private analysisCache: { key: string; at: number; candles: Candle[]; analysis: GoldAnalysis | null; error: string | null } | null = null
  private trendCache: { key: string; analysis: GoldAnalysis | null } | null = null
  private specCache: { symbol: string; at: number; inst: Instrument } | null = null
  private statsCache: { key: string; at: number; stats: GoldStatus['stats'] } | null = null
  private detectCache: { at: number; candidates: GoldCandidate[] } | null = null
  private orderQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly d: GoldDeps) {
    this.now = d.now ?? (() => Date.now())
  }

  // ---------- settings and the strategy ----------
  settings(): GoldSettings {
    return normalizeGoldSettings(getSetting(this.d.db, 'gold.settings', null))
  }

  private strategyId(): string | null {
    return getSetting<string | null>(this.d.db, 'gold.strategyId', null)
  }

  async saveSettings(input: GoldSettings, confirmLive = false): Promise<void> {
    const next = normalizeGoldSettings(input)
    const errors = validateGoldSettings(next)
    if (Object.keys(errors).length) throw new UserError('validation_failed', `Check the highlighted Gold Bot settings: ${Object.values(errors)[0]}`, errors)
    const prev = this.settings()
    if (next.accountMode === 'live' && prev.accountMode !== 'live' && !confirmLive) {
      throw new UserError('confirmation_required', 'Switching to live mode needs your confirmation: orders will then go to a real-money account.')
    }
    setSetting(this.d.db, 'gold.settings', next)
    audit(this.d.db, 'gold.settings_saved', { accountMode: next.accountMode, timeframe: next.timeframe, lotMode: next.lotMode })
    this.analysisCache = null
    await this.syncStrategy().catch((err) => this.d.log?.(`gold: strategy not updated: ${errorText(err)}`))
  }

  /** Symbol from the settings, else the best detected one; null when MT5 cannot list symbols. */
  async resolveSymbol(force = false): Promise<{ symbol: string | null; source: 'settings' | 'detected' | null; candidates: GoldCandidate[] }> {
    const s = this.settings()
    let candidates: GoldCandidate[] = this.detectCache?.candidates ?? []
    if (force || !this.detectCache || this.now() - this.detectCache.at > 10 * 60_000) {
      try {
        candidates = detectGoldSymbols(await this.d.market.instruments(force))
        this.detectCache = { at: this.now(), candidates }
      } catch {
        // offline: keep what was detected before
      }
    }
    if (s.symbol) return { symbol: s.symbol, source: 'settings', candidates }
    const best = candidates[0]?.symbol ?? null
    if (best) this.d.onSymbolDetected?.(best)
    return { symbol: best, source: best ? 'detected' : null, candidates }
  }

  /** Keeps the built-in strategy in line with the settings (a new version when something changed). */
  async syncStrategy(): Promise<{ id: string | null; problem: string | null }> {
    const { symbol } = await this.resolveSymbol()
    if (!symbol) return { id: this.strategyId(), problem: 'No gold symbol yet: connect MetaTrader 5 so the broker’s gold symbol (XAUUSD, GOLD, …) can be detected, or choose it in the settings.' }
    const def = goldDefinition(this.settings(), symbol)
    let id = this.strategyId()
    if (id) {
      try {
        await this.d.strategies.get(id)
      } catch {
        id = null // deleted on the Strategies page: create it again
      }
    }
    let saved
    if (id) saved = await this.d.strategies.save(id, def)
    else {
      try {
        saved = await this.d.strategies.save(undefined, def)
      } catch (err) {
        if (!(err instanceof UserError) || err.code !== 'validation_failed') throw err
        saved = await this.d.strategies.save(undefined, { ...def, name: `${GOLD_STRATEGY_NAME} (${symbol})` })
      }
      setSetting(this.d.db, 'gold.strategyId', saved.id)
    }
    if (!saved.validation.valid) return { id: saved.id, problem: saved.validation.errors[0]?.message ?? 'The Gold strategy is not valid.' }
    if (saved.status !== 'enabled') saved = await this.d.strategies.setEnabled(saved.id, true)
    // a running bot without a position switches to the new settings right away
    const session = this.currentSession(saved.id)
    if (session && !session.position && session.latestVersion !== null && session.strategyVersion !== null && session.latestVersion > session.strategyVersion) {
      await this.d.automation.applyLatestVersion(session.id).catch((err) => this.d.log?.(`gold: new settings apply later: ${errorText(err)}`))
    }
    return { id: saved.id, problem: null }
  }

  private currentSession(strategyId: string | null): AutomationSessionView | null {
    if (!strategyId) return null
    const sessions = this.d.automation.strategyActivity(strategyId, {}).sessions
    return sessions.find((s) => s.status !== 'stopped') ?? sessions.find((s) => s.position) ?? null
  }

  // ---------- account and market ----------
  private async accountNow() {
    const a = await this.d.conn.account()
    const t = this.d.conn.cachedTerminal() ?? (await this.d.conn.terminal().catch(() => null))
    return {
      login: a.login,
      server: a.server,
      currency: a.currency,
      balance: a.balance,
      equity: a.equity,
      marginFree: a.margin_free,
      leverage: a.leverage,
      mode: tradeModeOf(a),
      algoTrading: Boolean(a.trade_allowed && a.trade_expert && (t?.trade_allowed ?? true))
    }
  }

  /** Why the logged-in account does not fit the selected mode, or null. */
  accountModeProblem(mode: GoldSettings['accountMode'], account: { login: number; mode: 'demo' | 'contest' | 'real' } | null): string | null {
    if (!account) return null
    if (mode === 'demo' && account.mode !== 'demo') return `Demo mode is selected, but account ${account.login} is a ${account.mode === 'real' ? 'REAL-MONEY' : account.mode} account. Log in to a demo account in MetaTrader 5, or switch to live mode.`
    if (mode === 'live' && account.mode === 'demo') return `Live mode is selected, but account ${account.login} is a demo account. Switch to demo mode, or log in to your live account.`
    return null
  }

  private async candlesFor(symbol: string, s: GoldSettings): Promise<{ candles: Candle[]; analysis: GoldAnalysis | null; error: string | null }> {
    const step = TF_SECONDS[s.timeframe]
    const lastClosed = Math.floor(this.now() / 1000 / step) * step - step
    const key = `${symbol}|${s.timeframe}|${s.trendTimeframe}|${lastClosed}`
    if (this.analysisCache?.key === key && this.now() - this.analysisCache.at < ANALYSIS_TTL_MS) return this.analysisCache
    // enough entry candles for the M15 trend EMAs built from them
    const lookback = requiredBars(goldDefinition(s, symbol))
    const days = Math.ceil(((lookback + 5) * step) / 86400) + 3
    const all = await this.d.market.candles(symbol, s.timeframe, days, true)
    const candles = all.filter((c) => c.time <= lastClosed).slice(-lookback)
    let analysis: GoldAnalysis | null = null
    let error: string | null = null
    try {
      analysis = await this.d.engine<GoldAnalysis>('market_analysis', { candles: candles.slice(-400), emas: SCALP_EMAS })
    } catch (err) {
      error = errorText(err)
    }
    this.analysisCache = { key, at: this.now(), candles, analysis, error }
    return this.analysisCache
  }

  /** The trend timeframe's read-out (M15 by default), from its own closed candles. */
  private async trendAnalysis(symbol: string, s: GoldSettings): Promise<GoldAnalysis | null> {
    const step = TF_SECONDS[s.trendTimeframe]
    const lastClosed = Math.floor(this.now() / 1000 / step) * step - step
    const key = `${symbol}|${s.trendTimeframe}|${lastClosed}`
    if (this.trendCache?.key === key) return this.trendCache.analysis
    const all = await this.d.market.candles(symbol, s.trendTimeframe, Math.ceil((200 * step) / 86400) + 3, true)
    const candles = all.filter((c) => c.time <= lastClosed).slice(-200)
    const analysis = candles.length >= 50 ? await this.d.engine<GoldAnalysis>('market_analysis', { candles, emas: SCALP_EMAS }).catch(() => null) : null
    this.trendCache = { key, analysis }
    return analysis
  }

  /** Recent closed candles of M1, M5 or M15 for the charts. */
  async candles(timeframe: '1m' | '5m' | '15m'): Promise<CandleSeries> {
    const { symbol } = await this.resolveSymbol()
    if (!symbol) throw new UserError('no_symbol', 'No gold symbol yet: connect MetaTrader 5 first.')
    return this.d.market.series(symbol, timeframe as Timeframe, CHART_DAYS[timeframe])
  }

  private async instrumentOf(symbol: string): Promise<Instrument> {
    // the tick value moves with prices, but not second by second
    if (this.specCache?.symbol === symbol && this.now() - this.specCache.at < SPEC_TTL_MS) return this.specCache.inst
    const inst = await this.d.market.instrument(symbol)
    this.specCache = { symbol, at: this.now(), inst }
    return inst
  }

  private engineInstrument(inst: Instrument, spec: SizingSpec) {
    return { contractValue: spec.valuePerPoint, tickSize: inst.tickSize, ...spec, ...(inst.pipSize ? { pipSize: inst.pipSize } : {}) }
  }

  // ---------- positions and statistics ----------
  private sourceOf(p: Pick<Mt5Position, 'magic'>): GoldPositionView['source'] {
    return p.magic === this.d.botMagic ? 'bot' : p.magic === this.d.manualMagic ? 'manual' : 'other'
  }

  private async accountPositions(symbol: string): Promise<Mt5Position[]> {
    return (await this.d.conn.read((c) => c.positions({ symbol }))).filter((p) => p.symbol === symbol)
  }

  /** Current run (+wins / −losses) and the longest winning and losing runs, oldest trade first. */
  private streaks(results: boolean[]): { currentStreak: number; maxWinStreak: number; maxLossStreak: number } {
    let cur = 0
    let maxW = 0
    let maxL = 0
    for (const win of results) {
      cur = win ? (cur > 0 ? cur + 1 : 1) : cur < 0 ? cur - 1 : -1
      maxW = Math.max(maxW, cur)
      maxL = Math.max(maxL, -cur)
    }
    return { currentStreak: cur, maxWinStreak: maxW, maxLossStreak: maxL }
  }

  private async cachedAccountStats(symbol: string, currency: string): Promise<GoldStatus['stats']> {
    const key = `${symbol}|${currency}`
    if (this.statsCache?.key === key && this.now() - this.statsCache.at < STATS_TTL_MS) return this.statsCache.stats
    const stats = await this.accountStats(symbol, currency)
    this.statsCache = { key, at: this.now(), stats }
    return stats
  }

  /** Closed trades from the broker's deal history: TradePilot's (bot and manual) gold trades only. */
  private async accountStats(symbol: string, currency: string): Promise<GoldStatus['stats']> {
    const nowSec = Math.floor(this.now() / 1000)
    const deals: Mt5Deal[] = await this.d.conn.read((c) => c.historyDeals({ fromServerSec: this.d.conn.toServer(nowSec - STATS_DAYS * 86400), toServerSec: this.d.conn.toServer(nowSec) }))
    // positions TradePilot opened (bot or manual); their closing deals count whatever magic they carry
    // (a close by SL/TP or by hand in the terminal may not have TradePilot's magic number)
    const own = new Set(deals.filter((x) => x.symbol === symbol && x.entry === 0 && (x.magic === this.d.botMagic || x.magic === this.d.manualMagic)).map((x) => x.position_id))
    const relevant = deals.filter((x) => x.symbol === symbol && own.has(x.position_id))
    const net = (x: Mt5Deal) => x.profit + x.commission + x.swap + x.fee
    const today = utcDay(this.now())
    const isToday = (x: Mt5Deal) => utcDay(this.d.conn.toUtc(x.time_msc / 1000) * 1000) === today
    const closes = relevant.filter((x) => x.entry !== 0).sort((a, b) => a.time_msc - b.time_msc)
    const wins = closes.filter((x) => net(x) > 0).length
    return {
      ...this.streaks(closes.map((x) => net(x) > 0)),
      source: 'account' as const,
      currency,
      todayPnl: relevant.filter(isToday).reduce((a, x) => a + net(x), 0),
      todayTrades: relevant.filter((x) => x.entry === 0 && isToday(x)).length,
      totalTrades: closes.length,
      winRatePct: closes.length ? Math.round((wins / closes.length) * 1000) / 10 : null,
      netPnl: relevant.reduce((a, x) => a + net(x), 0),
      days: STATS_DAYS
    }
  }

  private paperStats(strategyId: string | null, symbol: string | null): GoldStatus['stats'] {
    const trades = strategyId ? this.d.automation.strategyActivity(strategyId, {}).trades.filter((t) => t.mode === 'paper' && (!symbol || t.symbol === symbol)) : []
    const today = utcDay(this.now())
    const wins = trades.filter((t) => t.netPnl > 0).length
    const todays = trades.filter((t) => t.exitTime.slice(0, 10) === today)
    return {
      ...this.streaks([...trades].sort((a, b) => a.exitTime.localeCompare(b.exitTime)).map((t) => t.netPnl > 0)),
      source: 'paper' as const,
      currency: 'paper',
      todayPnl: todays.reduce((a, t) => a + t.netPnl, 0),
      todayTrades: todays.length,
      totalTrades: trades.length,
      winRatePct: trades.length ? Math.round((wins / trades.length) * 1000) / 10 : null,
      netPnl: trades.reduce((a, t) => a + t.netPnl, 0),
      days: 0
    }
  }

  private manualRows(limit = 20): ManualRow[] {
    return this.d.db.prepare('SELECT * FROM manual_orders ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as ManualRow[]
  }

  private manualView(r: ManualRow): GoldManualOrderView {
    return { id: r.id, side: r.side, volume: r.volume, state: r.state, avgPrice: r.avg_price, stopLoss: r.stop_price, takeProfit: r.take_price, ticket: r.position_ticket, accountLogin: r.account_login, accountMode: r.account_mode, error: r.error, note: r.note, createdAt: r.created_at }
  }

  private recordManual(id: string, r: OrderResult | null, error: string | null, state?: OrderState) {
    const now = new Date(this.now()).toISOString()
    if (r) {
      this.d.db.prepare(`UPDATE manual_orders SET state = ?, filled = ?, avg_price = ?, fee = ?, exchange_order_id = ?, position_ticket = ?, error = NULL, note = CASE WHEN ? IS NULL THEN note ELSE trim(coalesce(note, '') || ' ' || ?) END, updated_at = ? WHERE id = ?`)
        .run(r.state, r.filled, r.avgPrice, r.fee, r.exchangeOrderId, r.positionTicket ?? null, r.note, r.note, now, id)
    } else {
      this.d.db.prepare('UPDATE manual_orders SET state = ?, error = ?, updated_at = ? WHERE id = ?').run(state ?? 'unknown', error, now, id)
    }
  }

  /** Manual orders whose result was unclear are looked up by their client id (never re-sent). */
  private async resolveUnknownManual(): Promise<void> {
    const open = this.d.db.prepare(`SELECT * FROM manual_orders WHERE state IN ('pending', 'unknown', 'open')`).all() as unknown as ManualRow[]
    if (!open.length) return
    const ex = this.d.manualExchange()
    for (const o of open) {
      const r = await ex.orderByClientId(o.client_order_id)
      if (r) this.recordManual(o.id, r, null)
      else if (this.now() - Date.parse(o.created_at) > UNKNOWN_GIVE_UP_MS) this.recordManual(o.id, null, 'MetaTrader 5 has no record of this order; it was not placed.', 'rejected')
    }
  }

  // ---------- status ----------
  async status(refresh = false): Promise<GoldStatus> {
    const settings = this.settings()
    const platformSupported = this.d.conn.client.unavailable() === null
    const configured = this.d.configured()
    const out: GoldStatus = {
      settings,
      risk: this.d.automation.risk(),
      platformSupported,
      configured,
      connected: false,
      userDisconnected: this.d.conn.isUserDisconnected(),
      connectionError: platformSupported ? null : this.d.conn.client.unavailable(),
      symbol: settings.symbol,
      symbolSource: settings.symbol ? 'settings' : null,
      candidates: [],
      spec: null,
      quote: null,
      account: null,
      accountModeProblem: null,
      analysis: null,
      analysisError: null,
      trendAnalysis: null,
      signal: null,
      signalError: null,
      bot: { strategyId: this.strategyId(), strategyProblem: null, session: null },
      liveEnabled: this.d.automation.liveEnabled('mt5').enabled,
      emergency: this.d.automation.emergency().active,
      positions: [],
      stats: this.paperStats(this.strategyId(), settings.symbol),
      manualOrders: this.manualRows().map((r) => this.manualView(r)),
      events: this.strategyId() ? this.d.automation.strategyActivity(this.strategyId()!, {}).events.slice(0, 30) : [],
      updatedAt: new Date(this.now()).toISOString()
    }
    out.bot.session = this.currentSession(out.bot.strategyId)

    const ready = platformSupported && configured && !out.userDisconnected
    if (ready) {
      try {
        await this.d.conn.ensure()
        out.connected = this.d.conn.isConnected()
      } catch (err) {
        out.connectionError = errorText(err)
      }
    } else if (!configured && platformSupported) out.connectionError = 'MetaTrader 5 is not set up. Enter your MT5 login, password and server in Settings → MetaTrader 5.'
    else if (out.userDisconnected) out.connectionError = 'Disconnected. Choose Connect to reconnect to MetaTrader 5.'

    const resolved = await this.resolveSymbol(refresh)
    out.symbol = resolved.symbol
    out.symbolSource = resolved.source
    out.candidates = resolved.candidates
    if (!out.symbol) out.bot.strategyProblem = 'No gold symbol yet: connect MetaTrader 5 so the broker’s gold symbol (XAUUSD, GOLD, …) can be detected, or choose it in the settings.'

    let inst: Instrument | null = null
    let spec: SizingSpec | null = null
    if (out.connected && out.symbol) {
      try {
        out.account = await this.accountNow()
        out.accountModeProblem = this.accountModeProblem(settings.accountMode, out.account)
      } catch (err) {
        out.connectionError = errorText(err)
      }
      try {
        inst = await this.instrumentOf(out.symbol)
        spec = sizingSpecOf(inst)
        out.spec = { digits: inst.digits ?? 2, tickSize: inst.tickSize, contractSize: inst.contractSize ?? null, valuePerPoint: inst.valuePerPoint ?? null, volumeMin: inst.volumeMin ?? null, volumeMax: inst.volumeMax ?? null, volumeStep: inst.volumeStep ?? null, minStopDistance: inst.minStopDistance ?? null, currency: inst.quoteAsset }
        const q = await this.d.market.quote(out.symbol)
        const snap = this.d.market.snapshot().quotes[out.symbol]
        const state = (await this.d.market.isMarketOpen(out.symbol)) ? (snap?.state ?? 'live') : 'closed'
        out.quote = { bid: q.bid, ask: q.ask, spread: Number((q.ask - q.bid).toFixed(Math.max(2, inst.digits ?? 2))), time: snap?.exchangeTime ?? null, state }
      } catch (err) {
        out.connectionError ??= errorText(err)
      }
      try {
        await this.resolveUnknownManual()
        out.manualOrders = this.manualRows().map((r) => this.manualView(r))
      } catch (err) {
        this.d.log?.(`gold: manual order check failed: ${errorText(err)}`)
      }
    }

    // positions: the account's gold positions, plus a simulated (paper) bot position
    if (out.connected && out.symbol) {
      try {
        for (const p of await this.accountPositions(out.symbol)) {
          const sess = this.d.automation.sessionForTicket(p.ticket)
          out.positions.push({ id: String(p.ticket), ticket: p.ticket, side: p.type === 0 ? 'long' : 'short', volume: p.volume, openPrice: p.price_open, stopLoss: p.sl || null, takeProfit: p.tp || null, profit: p.profit + p.swap, source: this.sourceOf(p), paper: false, sessionId: sess?.id ?? null })
        }
      } catch (err) {
        out.connectionError ??= errorText(err)
      }
    }
    const sess = out.bot.session
    if (sess?.mode === 'paper' && sess.position) {
      const mid = out.quote ? (out.quote.bid + out.quote.ask) / 2 : null
      const sign = sess.position.side === 'long' ? 1 : -1
      out.positions.push({ id: `paper:${sess.id}`, ticket: null, side: sess.position.side, volume: sess.position.contracts, openPrice: sess.position.entryPrice, stopLoss: sess.position.stopPrice, takeProfit: sess.position.takePrice, profit: mid === null ? null : sign * (mid - sess.position.entryPrice) * sess.position.contracts * sess.position.contractValue, source: 'bot', paper: true, sessionId: sess.id })
    }

    if (out.connected && out.symbol && out.account) {
      try {
        out.stats = await this.cachedAccountStats(out.symbol, out.account.currency)
      } catch (err) {
        this.d.log?.(`gold: statistics unavailable: ${errorText(err)}`)
      }
    }

    // analysis and the signal the bot's rules give right now
    if (out.connected && out.symbol && inst && spec) {
      try {
        const data = await this.candlesFor(out.symbol, settings)
        out.analysis = data.analysis
        out.analysisError = data.error
        out.trendAnalysis = await this.trendAnalysis(out.symbol, settings).catch(() => null)
        out.signal = await this.previewSignal(settings, out.symbol, inst, spec, data.candles, out)
      } catch (err) {
        out.signalError = errorText(err)
        out.analysisError ??= errorText(err)
      }
    }
    if (out.bot.strategyId === null && out.symbol) {
      const synced = await this.syncStrategy().catch((err) => ({ id: null, problem: errorText(err) }))
      out.bot.strategyId = synced.id
      out.bot.strategyProblem = synced.problem
    }
    return out
  }

  private async previewSignal(s: GoldSettings, symbol: string, inst: Instrument, spec: SizingSpec, candles: Candle[], st: GoldStatus): Promise<GoldSignalView> {
    if (candles.length < 30) return { action: 'wait', reason: `Only ${candles.length} closed candles are available; at least 30 are needed.`, blockedBy: [], entry: null, stopLoss: null, takeProfit: null, lots: null, candleTime: null }
    const accountMode = st.liveEnabled && st.account !== null
    const equity = accountMode ? st.account!.equity : this.d.automation.paperEquity()
    const tpOpen = st.positions.filter((p) => p.source !== 'other').length
    const exposure = st.positions.filter((p) => p.source !== 'other').reduce((a, p) => a + p.volume * (spec.valuePerPoint) * p.openPrice, 0)
    const sess = st.bot.session
    const decision = await this.d.engine<EngineDecision>('session_evaluate', {
      definition: goldDefinition(s, symbol),
      risk: this.d.automation.risk(),
      candles,
      session: { status: 'running', position: null, dayTrades: sess?.today.trades ?? 0, dayRealizedPnl: sess?.today.realizedPnl ?? 0, dayStartEquity: equity, lastSignalCandle: null, entriesAllowed: true, ...(sess ? this.d.automation.streakState(sess.id) : {}) },
      account: { equity, openExposureUsd: exposure, openPositions: tpOpen, dayStartEquity: equity - (st.stats.source === 'account' ? st.stats.todayPnl : 0), dayRealizedPnl: st.stats.source === 'account' ? st.stats.todayPnl : 0 },
      instrument: this.engineInstrument(inst, spec),
      quote: st.quote ? { mark: (st.quote.bid + st.quote.ask) / 2, bid: st.quote.bid, ask: st.quote.ask } : { mark: candles.at(-1)!.close },
      emergency: st.emergency,
      now: Math.floor(this.now() / 1000)
    })
    const it = decision.intent
    const wantsBuy = decision.signals.entryLong && !decision.signals.entryShort
    const wantsSell = decision.signals.entryShort && !decision.signals.entryLong
    const action: GoldSignalView['action'] = it.action === 'open_long' || (it.action === 'none' && wantsBuy) ? 'buy' : it.action === 'open_short' || (it.action === 'none' && wantsSell) ? 'sell' : 'wait'
    const opened = it.action === 'open_long' || it.action === 'open_short'
    const reason = opened ? 'All entry conditions are met on the last closed candle.' : decision.blockedBy.length ? 'Entry conditions are met, but a risk control or filter blocks the trade.' : action === 'wait' ? 'No entry: the trend, momentum and confirmation conditions are not all met on the last closed candle.' : it.reason
    return {
      action,
      reason,
      blockedBy: decision.blockedBy,
      entry: opened ? (st.quote ? (action === 'buy' ? st.quote.ask : st.quote.bid) : it.estPrice ?? null) : null,
      stopLoss: opened ? it.stopPrice ?? null : null,
      takeProfit: opened ? it.takePrice ?? null : null,
      lots: opened ? it.contracts ?? null : null,
      candleTime: decision.candleTime
    }
  }

  // ---------- bot ----------
  /** Starts the bot: on the MT5 account when automatic trading is on, otherwise simulated (paper). */
  async startBot(): Promise<void> {
    const synced = await this.syncStrategy()
    if (!synced.id || synced.problem) throw new UserError('strategy_invalid', synced.problem ?? 'The Gold strategy is not ready.')
    const live = this.d.automation.liveEnabled('mt5').enabled
    const s = this.settings()
    if (live) {
      const account = await this.accountNow()
      const problem = this.accountModeProblem(s.accountMode, account)
      if (problem) throw new UserError('account_mode', problem)
    }
    await this.d.automation.start(synced.id, live ? 'live' : 'paper', live ? { requireAccount: s.accountMode } : {})
    this.d.onChange?.()
  }

  async stopBot(closePosition: boolean): Promise<void> {
    const sess = this.currentSession(this.strategyId())
    if (!sess || (sess.status === 'stopped' && !sess.position)) throw new UserError('bad_state', 'The Gold Bot is not running.')
    await this.d.automation.stop(sess.id, closePosition)
    this.d.onChange?.()
  }

  // ---------- manual orders ----------
  /** One manual order at a time: limits are checked against positions that include the previous order. */
  async manualOrder(side: 'buy' | 'sell', requestId: string): Promise<GoldManualOrderView> {
    const run = this.orderQueue.then(() => this.placeManual(side, requestId))
    this.orderQueue = run.catch(() => undefined)
    return run
  }

  private async placeManual(side: 'buy' | 'sell', requestId: string): Promise<GoldManualOrderView> {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new UserError('validation_failed', 'Invalid request.')
    const existing = this.d.db.prepare('SELECT * FROM manual_orders WHERE request_id = ?').get(requestId) as unknown as ManualRow | undefined
    if (existing) return this.manualView(existing) // the same click arriving twice: never a second order
    const s = this.settings()
    const refuse = (msg: string): never => {
      throw new UserError('order_refused', `Order not sent: ${msg}`)
    }
    if (this.d.conn.client.unavailable()) refuse(this.d.conn.client.unavailable()!)
    if (!this.d.configured()) refuse('MetaTrader 5 is not set up.')
    if (this.d.automation.emergency().active) refuse('the emergency stop is active. Clear it first.')
    if (!this.d.automation.liveEnabled('mt5').enabled) refuse('automatic trading is off. Turn it on to allow TradePilot to place orders on your MT5 account.')
    const risk = this.d.automation.risk()
    if (!risk.configured) refuse('save the risk settings first.')
    await this.d.conn.ensure().catch((err) => refuse(`MetaTrader 5 is not connected (${errorText(err)}).`))
    const account = await this.accountNow()
    const modeProblem = this.accountModeProblem(s.accountMode, account)
    if (modeProblem) refuse(modeProblem)
    if (!account.algoTrading) refuse('Algo Trading is off in the MT5 terminal or not allowed for this account.')
    const { symbol } = await this.resolveSymbol()
    if (!symbol) refuse('no gold symbol is selected.')
    const inst = await this.d.market.instrument(symbol!)
    const spec = sizingSpecOf(inst)
    if (!spec) refuse(`${symbol} has no tick value or lot specification at your broker.`)
    if (!(await this.d.market.isMarketOpen(symbol!))) refuse(`the ${symbol} market is closed.`)
    const q = await this.d.market.quote(symbol!)
    const spread = q.ask - q.bid
    if (spread > s.maxSpread + 1e-9) refuse(`the spread (${spread.toFixed(inst.digits ?? 2)}) is above your maximum of ${s.maxSpread}.`)
    const price = side === 'buy' ? q.ask : q.bid
    const def = goldDefinition({ ...s, direction: 'both' }, symbol!)
    const { candles } = await this.candlesFor(symbol!, s)
    const levels = await this.d.engine<{ stopPrice: number; takePrice: number | null; stopDistance: number }>('protective_levels', { definition: def, side: side === 'buy' ? 'long' : 'short', entryPrice: price, candles, tickSize: inst.tickSize, pipSize: inst.pipSize ?? null })
    if (inst.minStopDistance && levels.stopDistance < inst.minStopDistance) refuse(`the stop-loss (${levels.stopDistance.toFixed(inst.digits ?? 2)} away) is closer than your broker allows (${inst.minStopDistance}). Raise the ATR multiple.`)

    // lots: exactly what the settings say, never rounded up; refused when not possible
    let lots: number
    if (s.lotMode === 'fixed') {
      if (!isValidVolume(s.fixedLots, spec!)) refuse(`${s.fixedLots} lots is not valid for ${symbol} (minimum ${spec!.volumeMin}, step ${spec!.volumeStep}${spec!.volumeMax ? `, maximum ${spec!.volumeMax}` : ''}).`)
      lots = s.fixedLots
    } else {
      const raw = (account.equity * s.riskPercent) / 100 / (levels.stopDistance * spec!.valuePerPoint)
      lots = roundVolumeDown(Math.min(raw, spec!.volumeMax ?? Infinity), spec!)
      if (lots < spec!.volumeMin - 1e-9) refuse(`risking ${s.riskPercent}% of ${account.equity.toFixed(2)} ${account.currency} with this stop allows ${raw.toFixed(4)} lots, below the minimum of ${spec!.volumeMin}. The minimum lot would risk ${((spec!.volumeMin * levels.stopDistance * spec!.valuePerPoint * 100) / account.equity).toFixed(2)}% of equity.`)
    }
    // account limits across the bot and manual trades
    const positions = await this.accountPositions(symbol!)
    const ours = positions.filter((p) => p.magic === this.d.botMagic || p.magic === this.d.manualMagic)
    if (ours.length >= risk.maxOpenPositions) refuse(`the maximum of ${risk.maxOpenPositions} open position${risk.maxOpenPositions === 1 ? '' : 's'} is reached.`)
    // as for the bot: the order may only shrink (in whole lot steps) to fit the size and exposure caps, never grow
    const perLot = spec!.valuePerPoint * price
    const exposure = ours.reduce((a, p) => a + p.volume * spec!.valuePerPoint * p.price_current, 0)
    const capOrder = roundVolumeDown(risk.maxOrderNotionalUsd / perLot, spec!)
    const room = (account.equity * risk.maxExposurePct) / 100 - exposure
    const capExposure = room > 0 ? roundVolumeDown(room / perLot, spec!) : 0
    const allowed = Math.min(lots, capOrder, capExposure)
    if (allowed < spec!.volumeMin - 1e-9) {
      refuse(capOrder <= capExposure
        ? `your maximum order size of ${risk.maxOrderNotionalUsd} ${account.currency} is below the value of the minimum lot (${(spec!.volumeMin * perLot).toFixed(0)} ${account.currency}). Raise it in Trading → Account risk settings.`
        : `total exposure would exceed ${risk.maxExposurePct}% of equity even with the minimum lot.`)
    }
    let note: string | null = null
    if (allowed < lots) {
      note = `Size reduced from ${lots} to ${allowed} lots by your ${capOrder <= capExposure ? 'maximum order size' : 'exposure'} limit.`
      lots = allowed
    }
    const stats = await this.accountStats(symbol!, account.currency)
    if (stats.todayTrades >= s.maxTradesPerDay) refuse(`the maximum of ${s.maxTradesPerDay} trades today is reached.`)
    const dayStart = account.equity - stats.todayPnl
    const lossLimitPct = Math.min(s.maxDailyLossPct, risk.accountMaxDailyLossPct)
    if (dayStart > 0 && stats.todayPnl <= (-dayStart * lossLimitPct) / 100) refuse(`today's loss has reached the daily limit of ${lossLimitPct}%.`)

    // recorded before sending: a crash or a repeated click can never send it twice
    const id = randomUUID()
    const clientOrderId = cid('m', requestId)
    const iso = new Date(this.now()).toISOString()
    try {
      this.d.db.prepare(
        `INSERT INTO manual_orders (id, broker, request_id, client_order_id, symbol, side, volume, stop_price, take_price, state, account_login, account_mode, note, created_at, updated_at)
         VALUES (?, 'mt5', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
      ).run(id, requestId, clientOrderId, symbol!, side, lots, levels.stopPrice, levels.takePrice, String(account.login), account.mode, note, iso, iso)
    } catch (err) {
      if (/UNIQUE/.test(errorText(err))) return this.manualView(this.d.db.prepare('SELECT * FROM manual_orders WHERE request_id = ?').get(requestId) as unknown as ManualRow)
      throw err
    }
    audit(this.d.db, 'gold.manual_order', { id, side, lots, symbol, accountMode: account.mode })
    try {
      const r = await this.d.manualExchange().placeMarket({ productId: 0, symbol: symbol!, side, size: lots, clientOrderId, reduceOnly: false, stopPrice: levels.stopPrice, takePrice: levels.takePrice, tickSize: inst.tickSize })
      this.recordManual(id, r, null)
    } catch (err) {
      const definitive = err instanceof ProviderError && ['invalid_request', 'auth', 'permission', 'not_found'].includes(err.kind)
      this.recordManual(id, null, errorText(err), definitive ? 'rejected' : 'unknown')
    }
    this.d.onChange?.()
    return this.manualView(this.d.db.prepare('SELECT * FROM manual_orders WHERE id = ?').get(id) as unknown as ManualRow)
  }

  // ---------- positions ----------
  private async positionFor(id: string): Promise<{ paperSession?: string; position?: Mt5Position; source: GoldPositionView['source']; sessionId: string | null }> {
    if (id.startsWith('paper:')) return { paperSession: id.slice(6), source: 'bot', sessionId: id.slice(6) }
    const ticket = Number(id)
    if (!Number.isInteger(ticket) || ticket <= 0) throw new UserError('validation_failed', 'Unknown position.')
    const rows = await this.d.conn.read((c) => c.positions({ ticket }))
    const position = rows.find((p) => p.ticket === ticket)
    if (!position) throw new UserError('not_found', `Position ${ticket} is no longer open.`)
    return { position, source: this.sourceOf(position), sessionId: this.d.automation.sessionForTicket(ticket)?.id ?? null }
  }

  async closePosition(id: string, confirmForeign = false): Promise<void> {
    const p = await this.positionFor(id)
    if (p.sessionId) {
      await this.d.automation.closePosition(p.sessionId, 'closed_by_user')
      return
    }
    if (p.source === 'other' && !confirmForeign) throw new UserError('confirmation_required', 'This position was not opened by TradePilot. Confirm that you want to close it.')
    const r = await this.d.manualExchange().closeTicket(p.position!.ticket, cid('c', `${p.position!.ticket}:${this.now()}`))
    audit(this.d.db, 'gold.position_closed', { ticket: p.position!.ticket, source: p.source, state: r.state })
    if (r.filled <= 0) throw new UserError('not_filled', `The close order for position ${p.position!.ticket} was ${r.state}; the position may still be open.`)
    this.d.onChange?.()
  }

  /** Closes every TradePilot gold position (bot and manual); other positions on the account are left alone. */
  async closeAll(): Promise<{ closed: number; failed: string[] }> {
    const st = await this.status()
    const failed: string[] = []
    let closed = 0
    for (const p of st.positions.filter((x) => x.source !== 'other')) {
      try {
        await this.closePosition(p.id)
        closed++
      } catch (err) {
        failed.push(`${p.paper ? 'paper position' : `#${p.ticket}`}: ${errorText(err)}`)
      }
    }
    return { closed, failed }
  }

  async modifyPosition(id: string, stopLoss: number | null, takeProfit: number | null): Promise<void> {
    const p = await this.positionFor(id)
    if (p.paperSession) {
      this.d.automation.setProtection(p.paperSession, stopLoss, takeProfit)
      return
    }
    if (p.source === 'other') throw new UserError('not_allowed', 'Only positions opened by TradePilot can be changed here.')
    if (stopLoss === null && p.source === 'bot') throw new UserError('validation_failed', 'Bot positions always keep a stop-loss.')
    await this.d.manualExchange().modifyStops(p.position!.ticket, stopLoss, takeProfit)
    if (p.sessionId) this.d.automation.setProtection(p.sessionId, stopLoss, takeProfit)
    audit(this.d.db, 'gold.position_modified', { ticket: p.position!.ticket, stopLoss, takeProfit })
    this.d.onChange?.()
  }

  // ---------- connection ----------
  async connect(): Promise<void> {
    const why = this.d.conn.unavailable()
    if (why && !this.d.conn.isUserDisconnected()) throw new UserError('not_available', why)
    await this.d.conn.connect()
    this.detectCache = null
    this.d.onChange?.()
  }

  async disconnect(): Promise<void> {
    const n = this.d.automation.activeLiveCount('mt5')
    if (n) throw new UserError('automation_active', `${n} live MetaTrader 5 automation${n === 1 ? ' is' : 's are'} running. Stop the bot first; open positions keep their stop-loss and take-profit at the broker.`)
    await this.d.conn.disconnect()
    this.d.onChange?.()
  }
}
