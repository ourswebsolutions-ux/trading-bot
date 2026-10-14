import type { DataState, MarketHealth, Quote } from '@shared/ipc'
import { ago, pct, price } from '../lib/format'
import { useNow } from '../lib/hooks'
import { Badge, StatusDot } from './ui'

const STATE_LABEL: Record<DataState, string> = { live: 'Live', delayed: 'Delayed', stale: 'Stale', unavailable: 'Unavailable' }
const STATE_TONE: Record<DataState, 'ok' | 'warn' | 'bad' | undefined> = { live: 'ok', delayed: 'warn', stale: 'bad', unavailable: undefined }

/** Re-evaluates freshness locally between updates so a frozen quote visibly ages out of "live". */
export function effectiveState(q: Quote | undefined, health: MarketHealth | undefined, now: number): DataState {
  if (!q) return 'unavailable'
  if (q.state === 'unavailable' || q.state === 'stale') return q.state
  const age = now - Date.parse(q.receivedAt)
  const staleAfter = health?.staleAfterMs ?? 15_000
  if (q.state === 'live' && age <= staleAfter) return 'live'
  return age <= staleAfter + 10_000 ? 'delayed' : 'stale'
}

export function FreshnessBadge({ state, title }: { state: DataState; title?: string }) {
  return (
    <span title={title}>
      <Badge tone={STATE_TONE[state]}>
        {state === 'live' && <span className="live-pulse" />}
        {STATE_LABEL[state]}
      </Badge>
    </span>
  )
}

export function QuoteLine({ q, health, compact }: { q: Quote | undefined; health: MarketHealth | undefined; compact?: boolean }) {
  const now = useNow(1000)
  const state = effectiveState(q, health, now)
  const sourceText = q ? `${q.source === 'websocket' ? 'stream' : 'REST'} · exchange time ${q.exchangeTime ? new Date(q.exchangeTime).toISOString().slice(11, 19) + ' UTC' : 'n/a'}` : ''
  return (
    <span className="quote-line">
      {q ? (
        <>
          <span className="num quote-price">{price(q.lastPrice ?? q.markPrice)}</span>
          {!compact && <span className={`num ${(q.change24hPct ?? 0) >= 0 ? 'up' : 'down'}`}>{pct(q.change24hPct)}</span>}
        </>
      ) : (
        <span className="faint">{health && health.transport !== 'offline' ? 'waiting for live price…' : 'no price'}</span>
      )}
      {(q || !health || health.transport === 'offline') && <FreshnessBadge state={state} title={sourceText} />}
      {q && !compact && <span className="faint quote-age">updated {ago(q.receivedAt, now)}</span>}
    </span>
  )
}

export function TransportStatus({ health }: { health: MarketHealth | undefined }) {
  if (!health) return <span className="status-item"><StatusDot />Market data…</span>
  const tone = health.transport === 'websocket' ? 'ok' : health.transport === 'rest' ? 'warn' : 'bad'
  const label = health.transport === 'websocket' ? 'Streaming' : health.transport === 'rest' ? (health.socket === 'disabled' ? 'REST polling' : `REST fallback (${health.socket})`) : 'Market data offline'
  return (
    <span className="status-item" title={`${health.regionLabel}${health.lastError ? ` — ${health.lastError}` : ''}`}>
      <StatusDot tone={tone} />
      {label}
    </span>
  )
}
