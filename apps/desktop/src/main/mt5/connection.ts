import { ProviderError } from '../net.js'
import type { Mt5Account, Mt5Client, Mt5Constants, Mt5Credentials, Mt5Terminal, Mt5Tick, Mt5TradeRequest } from './client.js'

/** Offsets are whole quarter hours (UTC+2, UTC+3, UTC+5:45…). */
const OFFSET_STEP_SEC = 900
/** Tolerance between a moving tick's time and "now" at the broker (network and polling delay). */
const FRESH_TICK_SEC = 90
/** Two observations of an advancing tick clock within this much real time prove the market is live. */
const MOVING_WITHIN_MS = 120_000
/** Broker server clocks lie between UTC-12 and UTC+14. */
const MAX_OFFSET_SEC = 14 * 3600

/**
 * One logged-in MT5 terminal session, shared by market data, account view and execution.
 * Connects lazily with the stored credentials, reconnects once for read-only calls, and never
 * repeats an order send (an unclear send is resolved by reconciliation instead).
 *
 * MT5 reports bar, tick and deal times in the broker's *server* time. The offset to UTC is
 * estimated from fresh ticks and remembered, because no ticks arrive while markets are closed.
 */
export class Mt5Connection {
  private connected = false
  private connecting: Promise<void> | null = null
  private lastAccount: Mt5Account | null = null
  private lastTerminal: Mt5Terminal | null = null
  private constantsCache: Mt5Constants | null = null
  lastError: string | null = null
  connectedAt: number | null = null
  private lastTick: { timeMsc: number; seenAt: number } | null = null
  /** Set by an explicit Disconnect: nothing reconnects until connect() is called. */
  private userDisconnected = false

  constructor(
    readonly client: Mt5Client,
    private readonly credentials: () => Mt5Credentials | null,
    private readonly offsetStore: { get: () => number | null; set: (sec: number) => void },
    private readonly now: () => number = () => Date.now(),
    private readonly log: (msg: string) => void = () => {}
  ) {}

  /** Null when MT5 can be used; otherwise what is missing. */
  unavailable(): string | null {
    return this.client.unavailable() ?? (this.credentials() ? null : 'MetaTrader 5 is not set up. Enter your MT5 login, password and server in Settings → MetaTrader 5.')
  }

  isConnected(): boolean {
    return this.connected
  }

  isUserDisconnected(): boolean {
    return this.userDisconnected
  }

  /** Disconnects on request; no read or order reconnects until connect(). */
  async disconnect(): Promise<void> {
    this.userDisconnected = true
    this.connected = false
    this.constantsCache = null
    await this.client.shutdown().catch(() => undefined)
    this.log('mt5: disconnected by the user')
  }

  /** Connects (again) on request, with a fresh login. */
  async connect(): Promise<void> {
    this.userDisconnected = false
    await this.reset()
    await this.ensure()
  }

  async ensure(): Promise<void> {
    if (this.userDisconnected) throw new ProviderError('provider', 'Disconnected from MetaTrader 5. Choose Connect to reconnect.')
    if (this.connected) return
    this.connecting ??= this.open().finally(() => (this.connecting = null))
    return this.connecting
  }

  private async open(): Promise<void> {
    const why = this.unavailable()
    if (why) throw new ProviderError('provider', why)
    try {
      const r = await this.client.connect(this.credentials()!)
      this.lastAccount = r.account
      this.lastTerminal = r.terminal
      this.connected = true
      this.connectedAt = this.now()
      this.lastError = null
      this.log(`mt5: connected to ${r.account.server} as ${r.account.login}`)
    } catch (err) {
      this.connected = false
      this.lastError = err instanceof Error ? err.message : String(err)
      throw err
    }
  }

  /** Re-login after settings changed. */
  async reset(): Promise<void> {
    this.connected = false
    this.constantsCache = null
    await this.client.shutdown().catch(() => undefined)
  }

  /** Read-only calls: one reconnect attempt if the terminal session dropped. */
  async read<T>(fn: (c: Mt5Client) => Promise<T>): Promise<T> {
    await this.ensure()
    try {
      return await fn(this.client)
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'network') {
        this.connected = false
        await this.ensure()
        return fn(this.client)
      }
      throw err
    }
  }

  /** Order sends go out exactly once. */
  async send(request: Mt5TradeRequest) {
    await this.ensure()
    return this.client.orderSend(request)
  }

  async constants(): Promise<Mt5Constants> {
    this.constantsCache ??= await this.read((c) => c.constants())
    return this.constantsCache
  }

  async account(): Promise<Mt5Account> {
    this.lastAccount = await this.read((c) => c.account())
    return this.lastAccount
  }

  async terminal(): Promise<Mt5Terminal> {
    this.lastTerminal = await this.read((c) => c.terminal())
    return this.lastTerminal
  }

  cachedAccount(): Mt5Account | null {
    return this.lastAccount
  }
  cachedTerminal(): Mt5Terminal | null {
    return this.lastTerminal
  }

  // ---------- server clock ----------
  /**
   * Learns the broker's UTC offset. A single tick cannot tell "old" from "another time zone"
   * (a tick from Friday evening can look like a fresh one at UTC-12), so the offset is taken
   * only from a tick whose clock has advanced since the previous one seen moments ago: the
   * market is moving, so that tick is "now" at the broker.
   */
  noteTick(t: Mt5Tick | null): void {
    if (!t || !t.time_msc) return
    const prev = this.lastTick
    const nowMs = this.now()
    if (!prev || t.time_msc > prev.timeMsc) this.lastTick = { timeMsc: t.time_msc, seenAt: nowMs }
    // the tick clock must advance about as fast as real time: a jump (Friday's last tick, then
    // Monday's first) proves nothing about the offset
    const elapsed = prev ? nowMs - prev.seenAt : 0
    const moving = prev !== null && t.time_msc > prev.timeMsc && elapsed <= MOVING_WITHIN_MS && t.time_msc - prev.timeMsc <= elapsed + FRESH_TICK_SEC * 1000
    if (!moving) return
    const diff = t.time_msc / 1000 - nowMs / 1000
    const offset = Math.round(diff / OFFSET_STEP_SEC) * OFFSET_STEP_SEC
    if (Math.abs(diff - offset) > FRESH_TICK_SEC || Math.abs(offset) > MAX_OFFSET_SEC) return
    if (offset !== this.offsetStore.get()) {
      this.offsetStore.set(offset)
      this.log(`mt5: broker server time is UTC${offset >= 0 ? '+' : '-'}${Math.abs(offset) / 3600}h`)
    }
  }

  /** Seconds to add to UTC to get server time; null until a fresh tick has been seen. */
  serverOffset(): number | null {
    return this.offsetStore.get()
  }

  toUtc(serverSec: number): number {
    return serverSec - (this.offsetStore.get() ?? 0)
  }

  toServer(utcSec: number): number {
    return utcSec + (this.offsetStore.get() ?? 0)
  }
}
