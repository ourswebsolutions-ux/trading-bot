/**
 * Delta Exchange public WebSocket with heartbeat watchdog, bounded exponential
 * reconnect and automatic re-subscription. Market data only; no order channels.
 */
export type SocketState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}
export type WebSocketFactory = (url: string) => WebSocketLike

export interface SocketTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  now: () => number
}

const realTimers: SocketTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  now: () => Date.now()
}

export const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/** Delta sends a heartbeat every ~5 s once enabled; no traffic for this long means the link is dead. */
export const HEARTBEAT_TIMEOUT_MS = 20_000

export interface SocketEvents {
  onMessage: (msg: Record<string, unknown>) => void
  onState: (state: SocketState, detail: { error?: string; attempt: number }) => void
}

export class DeltaSocket {
  private ws: WebSocketLike | null = null
  private state: SocketState = 'idle'
  private channels = new Map<string, Set<string>>()
  private watchdog: unknown = null
  private retryTimer: unknown = null
  private attempt = 0
  private stopped = false
  lastMessageAt: number | null = null
  reconnects = 0
  lastError: string | null = null

  constructor(
    private readonly url: string,
    private readonly events: SocketEvents,
    private readonly factory: WebSocketFactory = (u) => new WebSocket(u) as unknown as WebSocketLike,
    private readonly timers: SocketTimers = realTimers
  ) {}

  getState(): SocketState {
    return this.state
  }

  private setState(s: SocketState, error?: string) {
    this.state = s
    if (error) this.lastError = error
    this.events.onState(s, { error, attempt: this.attempt })
  }

  start(): void {
    this.stopped = false
    if (this.ws || this.state === 'connecting') return
    this.connect()
  }

  private connect() {
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting')
    let ws: WebSocketLike
    try {
      ws = this.factory(this.url)
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : 'connect failed')
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.lastError = null
      this.send({ type: 'enable_heartbeat' })
      this.sendSubscriptions()
      this.armWatchdog()
      this.setState('open')
    }
    ws.onmessage = (ev) => {
      this.lastMessageAt = this.timers.now()
      this.armWatchdog()
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      if (msg.type === 'subscriptions') this.attempt = 0 // healthy again: reset backoff
      if (msg.type === 'error') this.lastError = String((msg as { message?: string }).message ?? 'subscription error')
      this.events.onMessage(msg)
    }
    ws.onerror = () => {
      this.lastError = 'WebSocket error'
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      this.clearWatchdog()
      if (this.stopped) {
        this.setState('closed')
        return
      }
      this.scheduleReconnect(this.lastError ?? `connection closed${ev?.code ? ` (${ev.code})` : ''}`)
    }
  }

  private scheduleReconnect(reason: string) {
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!
    this.attempt++
    this.reconnects++
    this.setState('reconnecting', reason)
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null
      if (!this.stopped) this.connect()
    }, delay)
  }

  private armWatchdog() {
    this.clearWatchdog()
    this.watchdog = this.timers.setTimeout(() => {
      this.lastError = `no data for ${HEARTBEAT_TIMEOUT_MS / 1000}s`
      this.ws?.close(4000, 'heartbeat timeout')
      // some implementations never fire onclose after close() on a dead link
      const dead = this.ws
      if (dead) {
        this.ws = null
        dead.onclose = null
        this.scheduleReconnect(this.lastError)
      }
    }, HEARTBEAT_TIMEOUT_MS)
  }

  private clearWatchdog() {
    if (this.watchdog) this.timers.clearTimeout(this.watchdog)
    this.watchdog = null
  }

  private send(obj: unknown) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj))
  }

  private sendSubscriptions() {
    const channels = [...this.channels.entries()].filter(([, s]) => s.size > 0).map(([name, s]) => ({ name, symbols: [...s] }))
    if (channels.length) this.send({ type: 'subscribe', payload: { channels } })
  }

  /** Replaces the symbol set of a channel, sending only the difference. */
  setSubscription(channel: string, symbols: string[]): void {
    const next = new Set(symbols)
    const prev = this.channels.get(channel) ?? new Set<string>()
    const added = [...next].filter((s) => !prev.has(s))
    const removed = [...prev].filter((s) => !next.has(s))
    this.channels.set(channel, next)
    if (removed.length) this.send({ type: 'unsubscribe', payload: { channels: [{ name: channel, symbols: removed }] } })
    if (added.length) this.send({ type: 'subscribe', payload: { channels: [{ name: channel, symbols: added }] } })
  }

  stop(): void {
    this.stopped = true
    this.clearWatchdog()
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer)
    this.retryTimer = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.close(1000, 'stopped')
    }
    this.attempt = 0
    this.setState('closed')
  }
}
