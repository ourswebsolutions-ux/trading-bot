import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { ProviderError } from '../net.js'
import type { Timeframe } from '../../shared/ipc.js'

/**
 * Typed client for the MetaTrader 5 bridge process (engine/tradepilot_mt5), which wraps
 * MetaQuotes' official MetaTrader5 package. The package only exists on Windows and talks to a
 * locally installed, running MT5 terminal; elsewhere `unavailable()` says why.
 */

// ---------- rows as returned by the MetaTrader5 package (snake_case, broker server time) ----------
export interface Mt5Account {
  login: number
  trade_mode: number
  leverage: number
  trade_allowed: boolean
  trade_expert: boolean
  margin_mode: number
  balance: number
  equity: number
  margin: number
  margin_free: number
  name: string
  server: string
  currency: string
  company: string
}
export interface Mt5Terminal {
  connected: boolean
  trade_allowed: boolean
  tradeapi_disabled?: boolean
  build: number
  name: string
  path: string
}
export interface Mt5Symbol {
  name: string
  description: string
  path: string
  visible: boolean
  digits: number
  point: number
  spread: number
  trade_tick_value: number
  trade_tick_size: number
  trade_contract_size: number
  volume_min: number
  volume_max: number
  volume_step: number
  trade_mode: number
  trade_stops_level: number
  filling_mode: number
  currency_base: string
  currency_profit: string
  bid: number
  ask: number
  time: number
}
export interface Mt5Tick {
  time: number
  bid: number
  ask: number
  last: number
  time_msc: number
}
export interface Mt5Rate {
  time: number
  open: number
  high: number
  low: number
  close: number
  tick_volume: number
  spread: number
}
export interface Mt5SendResult {
  retcode: number
  deal: number
  order: number
  volume: number
  price: number
  bid: number
  ask: number
  comment: string
  request_id: number
  retcode_external: number
}
export interface Mt5Position {
  ticket: number
  time: number
  type: number
  magic: number
  identifier: number
  volume: number
  price_open: number
  sl: number
  tp: number
  price_current: number
  swap: number
  profit: number
  symbol: string
  comment: string
}
export interface Mt5HistoryOrder {
  ticket: number
  time_setup: number
  time_done: number
  type: number
  state: number
  magic: number
  position_id: number
  volume_initial: number
  volume_current: number
  symbol: string
  comment: string
}
export interface Mt5Deal {
  ticket: number
  order: number
  time: number
  time_msc: number
  type: number
  entry: number
  magic: number
  position_id: number
  volume: number
  price: number
  commission: number
  swap: number
  profit: number
  fee: number
  symbol: string
  comment: string
}
export interface Mt5TradeRequest {
  /** deal: market order · remove: delete a pending order · sltp: change an open position's stop-loss / take-profit */
  action: 'deal' | 'remove' | 'sltp'
  symbol?: string
  type?: 'buy' | 'sell'
  volume?: number
  price?: number
  sl?: number
  tp?: number
  deviation?: number
  magic?: number
  comment?: string
  filling?: 'fok' | 'ioc' | 'return'
  position?: number
  order?: number
}
export type Mt5Constants = Record<string, number | null>

export interface Mt5Credentials {
  login: string
  password: string
  server: string
  path?: string
}

/** Everything TradePilot asks of MT5. Implemented by the bridge process, and by fakes in tests. */
export interface Mt5Client {
  /** Null when usable; otherwise why MT5 cannot work on this machine. */
  unavailable(): string | null
  connect(c: Mt5Credentials): Promise<{ account: Mt5Account; terminal: Mt5Terminal }>
  shutdown(): Promise<void>
  account(): Promise<Mt5Account>
  terminal(): Promise<Mt5Terminal>
  symbols(): Promise<Mt5Symbol[]>
  symbolInfo(symbol: string): Promise<Mt5Symbol>
  ticks(symbols: string[]): Promise<Record<string, Mt5Tick | null>>
  rates(symbol: string, timeframe: Timeframe, count: number): Promise<Mt5Rate[]>
  orderSend(request: Mt5TradeRequest): Promise<Mt5SendResult>
  positions(q: { symbol?: string; ticket?: number; magic?: number }): Promise<Mt5Position[]>
  orders(q: { symbol?: string; magic?: number }): Promise<{ ticket: number; symbol: string; magic: number }[]>
  historyOrders(q: { fromServerSec?: number; toServerSec?: number; ticket?: number; magic?: number }): Promise<Mt5HistoryOrder[]>
  historyDeals(q: { fromServerSec?: number; toServerSec?: number; ticket?: number; position?: number; magic?: number }): Promise<Mt5Deal[]>
  constants(): Promise<Mt5Constants>
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/** Maps bridge errors to the app's provider errors (definitive vs. unknown outcome). */
function bridgeError(code: string, message: string): ProviderError {
  const kind =
    code === 'connect_failed' ? 'auth' : code === 'not_connected' || code === 'unavailable' || code === 'send_failed' ? 'network' : code === 'unknown_symbol' ? 'not_found' : code === 'invalid_request' ? 'invalid_request' : 'provider'
  return new ProviderError(kind, message)
}

export interface BridgeProcessOptions {
  /** Directory with run_mt5_bridge.py (development) — the Python sources. */
  engineDir: string
  /** Bundled executable (Windows installers); preferred when present. */
  bundledExecutable: string | null
  python: () => string
  platform?: NodeJS.Platform
  /** Tests: run another script (e.g. the fake bridge) on any platform. */
  overrideCommand?: { command: string; args: string[]; cwd: string }
  log?: (msg: string) => void
}

/**
 * Supervises the bridge process. The account password goes only into the connect message on
 * stdin; it is never logged, and error texts from the bridge never contain it.
 */
export class Mt5BridgeClient implements Mt5Client {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private stderrTail = ''

  constructor(private readonly o: BridgeProcessOptions) {}

  unavailable(): string | null {
    if (this.o.overrideCommand) return null
    if ((this.o.platform ?? process.platform) !== 'win32') return 'MetaTrader 5 needs Windows: the official MetaTrader5 package and the MT5 terminal only run there.'
    if (this.o.bundledExecutable && existsSync(this.o.bundledExecutable)) return null
    if (existsSync(path.join(this.o.engineDir, 'run_mt5_bridge.py'))) return null
    return 'The MetaTrader 5 bridge is missing from this installation. Reinstall TradePilot.'
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child
    const why = this.unavailable()
    if (why) throw new ProviderError('provider', why)
    const cmd = this.o.overrideCommand ??
      (this.o.bundledExecutable && existsSync(this.o.bundledExecutable)
        ? { command: this.o.bundledExecutable, args: [], cwd: path.dirname(this.o.bundledExecutable) }
        : { command: this.o.python(), args: ['-E', '-s', '-u', path.join(this.o.engineDir, 'run_mt5_bridge.py')], cwd: this.o.engineDir })
    const child = spawn(cmd.command, cmd.args, {
      cwd: cmd.cwd,
      env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true
    })
    this.child = child
    // writing to a bridge that already exited fails with EPIPE; the exit handler reports it
    child.stdin.on('error', (err) => this.o.log?.(`mt5 bridge stdin: ${err.message}`))
    child.stderr.on('data', (d: Buffer) => (this.stderrTail = (this.stderrTail + d.toString()).slice(-2000)))
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line))
    const failAll = (msg: string) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new ProviderError('network', msg))
      }
      this.pending.clear()
    }
    child.on('error', (err) => {
      if (this.child === child) this.child = null
      failAll(`The MetaTrader 5 bridge could not start: ${err.message}`)
    })
    child.on('exit', (code) => {
      if (this.child === child) this.child = null
      failAll(`The MetaTrader 5 bridge stopped (code ${code ?? 'signal'})${this.stderrTail ? `: ${this.stderrTail.trim().split('\n').at(-1)}` : ''}`)
    })
    return child
  }

  private onLine(line: string) {
    let msg: { id?: number; result?: unknown; error?: { code: string; message: string } }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined
    if (!p) return
    this.pending.delete(msg.id!)
    clearTimeout(p.timer)
    if (msg.error) p.reject(bridgeError(msg.error.code, msg.error.message))
    else p.resolve(msg.result)
  }

  private call<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.start()
    } catch (err) {
      return Promise.reject(err)
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // the outcome is unknown (e.g. an order may have reached the broker): callers reconcile
        reject(new ProviderError('timeout', `MetaTrader 5 did not answer ${method} within ${timeoutMs / 1000}s.`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  connect(c: Mt5Credentials) {
    return this.call<{ account: Mt5Account; terminal: Mt5Terminal }>('connect', { login: c.login, password: c.password, server: c.server, path: c.path || undefined, timeoutMs: 60_000 }, 90_000)
  }
  async shutdown() {
    if (!this.child) return
    await this.call('shutdown', {}, 10_000).catch(() => undefined)
    this.child?.kill()
    this.child = null
  }
  account() {
    return this.call<Mt5Account>('account', {})
  }
  terminal() {
    return this.call<Mt5Terminal>('terminal', {})
  }
  symbols() {
    return this.call<Mt5Symbol[]>('symbols', {}, 60_000)
  }
  symbolInfo(symbol: string) {
    return this.call<Mt5Symbol>('symbol_info', { symbol })
  }
  ticks(symbols: string[]) {
    return this.call<Record<string, Mt5Tick | null>>('ticks', { symbols })
  }
  rates(symbol: string, timeframe: Timeframe, count: number) {
    return this.call<Mt5Rate[]>('rates', { symbol, timeframe, count }, 60_000)
  }
  orderSend(request: Mt5TradeRequest) {
    return this.call<Mt5SendResult>('order_send', { request }, 30_000)
  }
  positions(q: { symbol?: string; ticket?: number; magic?: number }) {
    return this.call<Mt5Position[]>('positions', q)
  }
  orders(q: { symbol?: string; magic?: number }) {
    return this.call<{ ticket: number; symbol: string; magic: number }[]>('orders', q)
  }
  historyOrders(q: { fromServerSec?: number; toServerSec?: number; ticket?: number; magic?: number }) {
    return this.call<Mt5HistoryOrder[]>('history_orders', q)
  }
  historyDeals(q: { fromServerSec?: number; toServerSec?: number; ticket?: number; position?: number; magic?: number }) {
    return this.call<Mt5Deal[]>('history_deals', q)
  }
  constants() {
    return this.call<Mt5Constants>('constants', {})
  }
}
