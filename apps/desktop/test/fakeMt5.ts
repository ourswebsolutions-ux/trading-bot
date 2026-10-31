import { ProviderError } from '../src/main/net.js'
import type { Mt5Account, Mt5Client, Mt5Credentials, Mt5Deal, Mt5HistoryOrder, Mt5Position, Mt5Rate, Mt5SendResult, Mt5Symbol, Mt5Terminal, Mt5Tick, Mt5TradeRequest } from '../src/main/mt5/client.js'
import type { Timeframe } from '../src/shared/ipc.js'

/**
 * Scripted MetaTrader 5 terminal for tests only. The broker's server clock runs at UTC+3 (like
 * many MT5 brokers), so every time it reports is shifted, as with a real terminal.
 */
export const SERVER_OFFSET_SEC = 3 * 3600
const TF_SEC: Record<Timeframe, number> = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 }

/** Spot gold as most MT5 brokers quote it: 2 digits, 100 oz per lot, 1 USD per 0.01 move per lot. */
export function goldSymbol(over: Partial<Mt5Symbol> = {}): Mt5Symbol {
  return fxSymbol({
    name: 'XAUUSD', description: 'Gold vs US Dollar', path: 'Metals\\XAUUSD', digits: 2, point: 0.01, spread: 25,
    trade_tick_value: 1, trade_tick_size: 0.01, trade_contract_size: 100, volume_min: 0.01, volume_max: 100, volume_step: 0.01,
    trade_stops_level: 50, filling_mode: 3, currency_base: 'XAU', currency_profit: 'USD', bid: 2650, ask: 2650.25, ...over
  })
}

export function fxSymbol(over: Partial<Mt5Symbol> = {}): Mt5Symbol {
  return {
    name: 'EURUSD', description: 'Euro vs US Dollar', path: 'Forex\\Majors\\EURUSD', visible: true, digits: 5, point: 0.00001, spread: 12,
    trade_tick_value: 1, trade_tick_size: 0.00001, trade_contract_size: 100_000, volume_min: 0.01, volume_max: 50, volume_step: 0.01,
    trade_mode: 4, trade_stops_level: 10, filling_mode: 2, currency_base: 'EUR', currency_profit: 'USD', bid: 1.085, ask: 1.08512, time: 0, ...over
  }
}

export class FakeMt5 implements Mt5Client {
  unavailableReason: string | null = null
  connected = false
  password = 'demo-pass'
  account_: Mt5Account = { login: 51234567, trade_mode: 0, leverage: 100, trade_allowed: true, trade_expert: true, margin_mode: 2, balance: 10_000, equity: 10_000, margin: 0, margin_free: 10_000, name: 'Demo', server: 'Broker-Demo', currency: 'USD', company: 'Example Broker' }
  terminal_: Mt5Terminal = { connected: true, trade_allowed: true, build: 4410, name: 'MetaTrader 5', path: 'C:\\MT5' }
  symbols_: Record<string, Mt5Symbol> = {
    EURUSD: fxSymbol(),
    USDJPY: fxSymbol({ name: 'USDJPY', description: 'US Dollar vs Yen', path: 'Forex\\Majors\\USDJPY', digits: 3, point: 0.001, trade_tick_value: 0.6667, trade_tick_size: 0.001, trade_stops_level: 0, filling_mode: 1, currency_base: 'USD', currency_profit: 'JPY', bid: 150, ask: 150.015 })
  }
  positions_: Mt5Position[] = []
  historyOrders_: Mt5HistoryOrder[] = []
  deals_: Mt5Deal[] = []
  sent: Mt5TradeRequest[] = []
  connects = 0
  /** Next order_send outcome: a retcode, 'timeout' (no answer; the order may still execute) or 'network' (process dropped). */
  nextSend: number | 'timeout_filled' | 'timeout_lost' | 'network' = 10009
  /** Ticks stop arriving (market closed). */
  frozen = false
  tickTimeUtcMs: number | null = null
  private ticket = 1000

  constructor(public nowMs: () => number) {}

  private serverSec(utcMs = this.nowMs()) {
    return Math.floor(utcMs / 1000) + SERVER_OFFSET_SEC
  }
  private need() {
    if (!this.connected) throw new ProviderError('network', 'Not connected to the MetaTrader 5 terminal. Connect first.')
  }
  setPrice(symbol: string, bid: number, spread = 0.00012) {
    this.symbols_[symbol] = { ...this.symbols_[symbol]!, bid, ask: Number((bid + spread).toFixed(10)) }
  }

  unavailable() {
    return this.unavailableReason
  }
  async connect(c: Mt5Credentials) {
    this.connects++
    if (c.password !== this.password) throw new ProviderError('auth', 'Could not connect to the MetaTrader 5 terminal or log in: Terminal: Authorization failed (-6)')
    this.connected = true
    return { account: this.account_, terminal: this.terminal_ }
  }
  async shutdown() {
    this.connected = false
  }
  async account() {
    this.need()
    return { ...this.account_ }
  }
  async terminal() {
    this.need()
    return { ...this.terminal_ }
  }
  async symbols() {
    this.need()
    return Object.values(this.symbols_)
  }
  async symbolInfo(symbol: string) {
    this.need()
    const s = this.symbols_[symbol]
    if (!s) throw new ProviderError('not_found', `${symbol} is not available at this broker`)
    return s
  }
  async ticks(symbols: string[]) {
    this.need()
    const out: Record<string, Mt5Tick | null> = {}
    for (const sym of symbols) {
      const s = this.symbols_[sym]
      const utc = this.frozen ? (this.tickTimeUtcMs ?? this.nowMs() - 48 * 3600_000) : this.nowMs()
      out[sym] = s ? { time: this.serverSec(utc), bid: s.bid, ask: s.ask, last: 0, time_msc: this.serverSec(utc) * 1000 } : null
    }
    return out
  }
  /** Bars at the current price; the newest one is still forming (as copy_rates_from_pos returns it). */
  async rates(symbol: string, timeframe: Timeframe, count: number): Promise<Mt5Rate[]> {
    this.need()
    const s = this.symbols_[symbol]
    if (!s) throw new ProviderError('not_found', `No price history for ${symbol}`)
    const step = TF_SEC[timeframe]
    const current = Math.floor(this.serverSec() / step) * step
    return Array.from({ length: count }, (_, i) => {
      const t = current - (count - 1 - i) * step
      return { time: t, open: s.bid, high: s.bid * 1.0005, low: s.bid * 0.9995, close: s.bid, tick_volume: 100, spread: s.spread }
    })
  }
  async orderSend(r: Mt5TradeRequest): Promise<Mt5SendResult> {
    this.need()
    this.sent.push({ ...r })
    const mode = this.nextSend
    this.nextSend = 10009
    if (mode === 'network') throw new ProviderError('network', 'The MetaTrader 5 bridge stopped (code 1)')
    if (typeof mode === 'number' && mode !== 10009) return { retcode: mode, deal: 0, order: 0, volume: 0, price: 0, bid: 0, ask: 0, comment: 'rejected', request_id: 1, retcode_external: 0 }
    if (r.action === 'remove') return { retcode: 10009, deal: 0, order: r.order ?? 0, volume: 0, price: 0, bid: 0, ask: 0, comment: 'Done', request_id: 1, retcode_external: 0 }
    if (r.action === 'sltp') {
      const p = this.positions_.find((x) => x.ticket === r.position)
      if (!p) return { retcode: 10036, deal: 0, order: 0, volume: 0, price: 0, bid: 0, ask: 0, comment: 'Position closed', request_id: 1, retcode_external: 0 }
      this.positions_ = this.positions_.map((x) => (x === p ? { ...x, sl: r.sl ?? 0, tp: r.tp ?? 0 } : x))
      return { retcode: 10009, deal: 0, order: 0, volume: 0, price: 0, bid: 0, ask: 0, comment: 'Request executed', request_id: 1, retcode_external: 0 }
    }
    const s = this.symbols_[r.symbol!]!
    const price = r.type === 'buy' ? s.ask : s.bid
    const order = ++this.ticket
    const deal = order + 5000
    const nowServer = this.serverSec()
    let positionId = order
    if (r.position) {
      // closing an existing position by ticket
      const p = this.positions_.find((x) => x.ticket === r.position)
      positionId = r.position
      if (p) {
        const left = Number((p.volume - r.volume!).toFixed(8))
        this.positions_ = left > 0 ? this.positions_.map((x) => (x === p ? { ...x, volume: left } : x)) : this.positions_.filter((x) => x !== p)
      }
      this.deals_.push({ ticket: deal, order, time: nowServer, time_msc: nowServer * 1000, type: r.type === 'buy' ? 0 : 1, entry: 1, magic: r.magic ?? 0, position_id: positionId, volume: r.volume!, price, commission: -3.5 * r.volume!, swap: 0, profit: 0, fee: 0, symbol: r.symbol!, comment: r.comment ?? '' })
    } else {
      this.positions_.push({ ticket: order, time: nowServer, type: r.type === 'buy' ? 0 : 1, magic: r.magic ?? 0, identifier: order, volume: r.volume!, price_open: price, sl: r.sl ?? 0, tp: r.tp ?? 0, price_current: price, swap: 0, profit: 0, symbol: r.symbol!, comment: r.comment ?? '' })
      this.deals_.push({ ticket: deal, order, time: nowServer, time_msc: nowServer * 1000, type: r.type === 'buy' ? 0 : 1, entry: 0, magic: r.magic ?? 0, position_id: order, volume: r.volume!, price, commission: -3.5 * r.volume!, swap: 0, profit: 0, fee: 0, symbol: r.symbol!, comment: r.comment ?? '' })
    }
    this.historyOrders_.push({ ticket: order, time_setup: nowServer, time_done: nowServer, type: r.type === 'buy' ? 0 : 1, state: 4, magic: r.magic ?? 0, position_id: positionId, volume_initial: r.volume!, volume_current: 0, symbol: r.symbol!, comment: (r.comment ?? '').slice(0, 31) })
    if (mode === 'timeout_filled') throw new ProviderError('timeout', 'MetaTrader 5 did not answer order_send within 30s.')
    if (mode === 'timeout_lost') {
      this.positions_.pop()
      this.deals_.pop()
      this.historyOrders_.pop()
      throw new ProviderError('timeout', 'MetaTrader 5 did not answer order_send within 30s.')
    }
    return { retcode: 10009, deal, order, volume: r.volume!, price, bid: s.bid, ask: s.ask, comment: 'Request executed', request_id: 1, retcode_external: 0 }
  }
  /** The broker closes a position at its stop-loss (as the trade server would). */
  hitStop(ticket: number) {
    const p = this.positions_.find((x) => x.ticket === ticket)!
    this.positions_ = this.positions_.filter((x) => x !== p)
    const nowServer = this.serverSec()
    this.deals_.push({ ticket: ++this.ticket + 5000, order: this.ticket, time: nowServer, time_msc: nowServer * 1000, type: p.type === 0 ? 1 : 0, entry: 1, magic: p.magic, position_id: p.ticket, volume: p.volume, price: p.sl, commission: -3.5 * p.volume, swap: -0.4, profit: 0, fee: 0, symbol: p.symbol, comment: '[sl]' })
  }
  async positions(q: { symbol?: string; ticket?: number; magic?: number }) {
    this.need()
    return this.positions_.filter((p) => (q.symbol === undefined || p.symbol === q.symbol) && (q.ticket === undefined || p.ticket === q.ticket) && (q.magic === undefined || p.magic === q.magic))
  }
  async orders() {
    this.need()
    return []
  }
  async historyOrders(q: { ticket?: number; magic?: number }) {
    this.need()
    return this.historyOrders_.filter((o) => (q.ticket === undefined || o.ticket === q.ticket) && (q.magic === undefined || o.magic === q.magic))
  }
  async historyDeals(q: { ticket?: number; position?: number; magic?: number; fromServerSec?: number; toServerSec?: number }) {
    this.need()
    return this.deals_.filter((d) => (q.ticket === undefined || d.ticket === q.ticket) && (q.position === undefined || d.position_id === q.position) && (q.magic === undefined || d.magic === q.magic) && (q.fromServerSec === undefined || d.time >= q.fromServerSec - 2 * 86400))
  }
  async constants() {
    return { TRADE_RETCODE_DONE: 10009 }
  }
}
