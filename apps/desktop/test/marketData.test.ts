import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DeltaRest, type DeltaTicker } from '../src/main/delta/rest.js'
import { BACKOFF_MS, DeltaSocket, HEARTBEAT_TIMEOUT_MS, type SocketTimers, type WebSocketLike } from '../src/main/delta/socket.js'
import { classify, findGaps, MarketDataService, type MarketSettings } from '../src/main/marketData.js'
import { fakeFetch } from './helpers.js'

class FakeSocket implements WebSocketLike {
  readyState = 0
  sent: unknown[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  send(d: string) {
    this.sent.push(JSON.parse(d))
  }
  close() {
    this.closed = true
    this.readyState = 3
    this.onclose?.({ code: 1006 })
  }
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  message(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
}

class ManualTimers implements SocketTimers {
  t = 0
  private queue: { at: number; fn: () => void; id: number }[] = []
  private seq = 0
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq
    this.queue.push({ at: this.t + ms, fn, id })
    return id
  }
  clearTimeout = (h: unknown) => {
    this.queue = this.queue.filter((q) => q.id !== h)
  }
  now = () => this.t
  advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at)
      const next = this.queue[0]
      if (!next || next.at > end) break
      this.queue.shift()
      this.t = next.at
      next.fn()
    }
    this.t = end
  }
}

function setup() {
  const sockets: FakeSocket[] = []
  const states: string[] = []
  const timers = new ManualTimers()
  const messages: Record<string, unknown>[] = []
  const sock = new DeltaSocket('wss://test', { onMessage: (m) => messages.push(m), onState: (s) => states.push(s) }, () => {
    const s = new FakeSocket()
    sockets.push(s)
    return s
  }, timers)
  return { sock, sockets, states, timers, messages }
}

describe('Delta WebSocket client', () => {
  it('enables heartbeats and subscribes on open, sending only diffs afterwards', () => {
    const { sock, sockets } = setup()
    sock.setSubscription('v2/ticker', ['BTCUSD'])
    sock.start()
    sockets[0]!.open()
    assert.deepEqual(sockets[0]!.sent[0], { type: 'enable_heartbeat' })
    assert.deepEqual(sockets[0]!.sent[1], { type: 'subscribe', payload: { channels: [{ name: 'v2/ticker', symbols: ['BTCUSD'] }] } })
    sock.setSubscription('v2/ticker', ['ETHUSD'])
    assert.deepEqual(sockets[0]!.sent.slice(2), [
      { type: 'unsubscribe', payload: { channels: [{ name: 'v2/ticker', symbols: ['BTCUSD'] }] } },
      { type: 'subscribe', payload: { channels: [{ name: 'v2/ticker', symbols: ['ETHUSD'] }] } }
    ])
  })

  it('reconnects with bounded exponential backoff and re-subscribes', () => {
    const { sock, sockets, timers } = setup()
    sock.setSubscription('v2/ticker', ['BTCUSD'])
    sock.start()
    sockets[0]!.open()
    for (let i = 0; i < 7; i++) {
      sockets.at(-1)!.close()
      const delay = BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]!
      timers.advance(delay - 1)
      assert.equal(sockets.length, i + 1, 'no reconnect before the backoff elapses')
      timers.advance(1)
      assert.equal(sockets.length, i + 2)
    }
    sockets.at(-1)!.open()
    assert.deepEqual(sockets.at(-1)!.sent[1], { type: 'subscribe', payload: { channels: [{ name: 'v2/ticker', symbols: ['BTCUSD'] }] } })
    sockets.at(-1)!.message({ type: 'subscriptions', channels: [] })
    sockets.at(-1)!.close()
    timers.advance(BACKOFF_MS[0]!)
    assert.equal(sockets.length, 9, 'backoff resets after a confirmed subscription')
    assert.ok(sock.reconnects >= 8)
  })

  it('treats a silent connection as dead after the heartbeat timeout', () => {
    const { sock, sockets, timers, states } = setup()
    sock.start()
    sockets[0]!.open()
    timers.advance(HEARTBEAT_TIMEOUT_MS - 1000)
    sockets[0]!.message({ type: 'heartbeat' })
    timers.advance(HEARTBEAT_TIMEOUT_MS - 1000)
    assert.equal(sockets.length, 1, 'heartbeat kept it alive')
    timers.advance(1001)
    assert.equal(sockets[0]!.closed, true)
    assert.ok(states.includes('reconnecting'))
    timers.advance(BACKOFF_MS[0]!)
    assert.equal(sockets.length, 2)
  })

  it('stop() cancels pending reconnects', () => {
    const { sock, sockets, timers } = setup()
    sock.start()
    sockets[0]!.open()
    sockets[0]!.close()
    sock.stop()
    timers.advance(60_000)
    assert.equal(sockets.length, 1)
    assert.equal(sock.getState(), 'closed')
  })
})

const settings: MarketSettings = { useWebSocket: true, staleAfterSec: 15, pollIntervalSec: 10 }
const tick = (symbol: string, micros: number, price: number): DeltaTicker => ({ symbol, mark_price: price, close: price, open: price * 0.99, timestamp: micros })

describe('market data freshness and integrity', () => {
  it('classifies live, delayed, stale and unavailable honestly', () => {
    const ws = { quote: { source: 'websocket' as const }, receivedAtMs: 0 }
    const rest = { quote: { source: 'rest' as const }, receivedAtMs: 0 }
    assert.equal(classify(undefined, 0, true, settings), 'unavailable')
    assert.equal(classify(ws, 10_000, true, settings), 'live')
    assert.equal(classify(ws, 10_000, false, settings), 'delayed', 'stream down: not live even if recent')
    assert.equal(classify(ws, 16_000, true, settings), 'delayed')
    assert.equal(classify(rest, 5_000, true, settings), 'delayed', 'REST data is never labelled live')
    assert.equal(classify(rest, 21_000, true, settings), 'stale')
  })

  it('finds missing candles instead of inventing them', () => {
    const c = (t: number) => ({ time: t, open: 1, high: 1, low: 1, close: 1, volume: 0 })
    assert.deepEqual(findGaps([c(0), c(60), c(240), c(300)], 60), [{ from: 120, to: 180, missing: 2 }])
    assert.deepEqual(findGaps([c(0), c(60)], 60), [])
  })

  it('ignores duplicate and out-of-order ticks and streams candle updates once', async () => {
    let now = 1_000_000
    const sockets: FakeSocket[] = []
    const snapshots: unknown[] = []
    const candles: unknown[] = []
    const f = fakeFetch(() => [200, { success: true, result: [{ id: 1, symbol: 'BTCUSD', contract_type: 'perpetual_futures', state: 'live', tick_size: '0.5' }] }])
    const svc = new MarketDataService({
      region: () => 'india',
      settings: () => settings,
      onSnapshot: (s) => snapshots.push(s),
      onCandle: (c) => candles.push(c),
      restFactory: (r) => new DeltaRest(r, null, f.impl),
      socketFactory: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      now: () => now
    })
    svc.start()
    await svc.instruments()
    svc.watch('dash', ['BTCUSD'], { symbol: 'BTCUSD', timeframe: '1h' })
    sockets[0]!.open()
    const subs = sockets[0]!.sent.filter((m) => (m as { type: string }).type === 'subscribe')
    assert.ok(JSON.stringify(subs).includes('"candlestick_1h"'))

    assert.equal(svc.ingestTicker(tick('BTCUSD', 2_000, 100), 'websocket'), true)
    assert.equal(svc.ingestTicker(tick('BTCUSD', 2_000, 100), 'websocket'), false, 'duplicate')
    assert.equal(svc.ingestTicker(tick('BTCUSD', 1_000, 90), 'rest'), false, 'older')
    let q = svc.snapshot().quotes.BTCUSD!
    assert.equal(q.lastPrice, 100)
    assert.equal(q.state, 'live')
    assert.equal(q.exchangeTime, new Date(2).toISOString())
    now += 18_000
    assert.equal(svc.snapshot().quotes.BTCUSD!.state, 'delayed', 'no update for 18s: no longer live')
    now += 7_000
    q = svc.snapshot().quotes.BTCUSD!
    assert.equal(q.state, 'stale', 'no update for 25s')
    assert.equal(svc.health().duplicatesIgnored, 2)

    const candle = { type: 'candlestick_1h', symbol: 'BTCUSD', resolution: '1h', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, candle_start_time: 3_600_000_000, last_updated: 5 }
    sockets[0]!.message(candle)
    sockets[0]!.message(candle)
    sockets[0]!.message({ ...candle, last_updated: 6, close: 1.6 })
    assert.equal(candles.length, 2)
    assert.deepEqual((candles[1] as { candle: { time: number; close: number } }).candle, { time: 3600, open: 1, high: 2, low: 0.5, close: 1.6, volume: 10 })
    svc.stop()
  })

  it('refuses instruments that are not listed in the region', async () => {
    const f = fakeFetch(() => [200, { success: true, result: [{ id: 1, symbol: 'BTCUSDT', contract_type: 'perpetual_futures', state: 'live', tick_size: '0.5' }] }])
    const svc = new MarketDataService({ region: () => 'global', settings: () => ({ ...settings, useWebSocket: false }), onSnapshot: () => {}, onCandle: () => {}, restFactory: (r) => new DeltaRest(r, null, f.impl) })
    await assert.rejects(svc.series('BTCUSD', '1h', 1), /not a live perpetual contract on Delta Exchange Global/)
    svc.watch('x', ['BTCUSD'])
    await svc.instruments()
    assert.deepEqual(svc.health().unsupported, ['BTCUSD'])
    svc.stop()
  })
})
