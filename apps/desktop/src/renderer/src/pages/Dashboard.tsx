import { useEffect, useState } from 'react'
import type { IntegrationId, IntegrationView, Timeframe } from '@shared/ipc'
import { CandleChart } from '../components/charts'
import { Icon } from '../components/icons'
import { QuoteLine, TransportStatus } from '../components/market'
import { Badge, Button, Empty, ErrorState, Panel, Segmented, Skeleton, StatusDot } from '../components/ui'
import { call } from '../lib/api'
import { ago, compact, date, duration, money, pct, price, qty } from '../lib/format'
import { useEvent, useNow, useResource } from '../lib/hooks'
import { useLiveSeries, useMarketWatch } from '../lib/market'
import { serverNow, useApp } from '../lib/state'

const TF_DAYS: Record<Timeframe, number> = { '5m': 2, '15m': 5, '1h': 14, '4h': 45, '1d': 240 }
const SERVICE_LABEL: Record<IntegrationId, string> = { delta: 'Delta Exchange account', marketdata: 'Market data', openai: 'OpenAI', anthropic: 'Anthropic Claude', smtp: 'SMTP email', whatsapp: 'WhatsApp Business' }

function AccessTile() {
  const { subscription, navigate } = useApp()
  const now = useNow(1000)
  const s = subscription?.status
  let value = '—'
  let sub = subscription?.access.detail ?? 'Checking…'
  if (s?.subscription?.status === 'active') {
    value = s.subscription.planCode === 'lifetime' ? 'Lifetime' : 'Monthly'
    sub = s.subscription.expiresAt ? `Renews/expires ${date(s.subscription.expiresAt)}` : 'No expiry'
  } else if (s?.trial.active) {
    value = duration(Math.max(0, Date.parse(s.trial.endsAt) - serverNow(subscription, now)))
    sub = `Free trial · ends ${date(s.trial.endsAt)}`
  } else if (s) {
    value = 'Inactive'
    sub = 'Paid features paused'
  }
  return (
    <button className="panel tile" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => navigate('subscription')}>
      <span className="label">Access</span>
      <span className="value">{value}</span>
      <span className="sub">{sub}</span>
    </button>
  )
}

function ServiceRow({ tone, name, detail, onClick }: { tone?: 'ok' | 'bad' | 'warn'; name: string; detail: string; onClick: () => void }) {
  return (
    <div className="service-row" role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <StatusDot tone={tone} />
      <div style={{ minWidth: 0 }}>
        <div className="s-name">{name}</div>
        <div className="s-detail" title={detail}>{detail}</div>
      </div>
      <Icon name="external" size={12} style={{ color: 'var(--text-3)' }} />
    </div>
  )
}

function Services({ integrations, health }: { integrations: IntegrationView[] | undefined; health: Parameters<typeof TransportStatus>[0]['health'] }) {
  const { navigate, subscription, engine, updates } = useApp()
  const now = useNow(15_000)
  const integ = (id: IntegrationId) => integrations?.find((v) => v.id === id)
  const describe = (v: IntegrationView | undefined) => {
    if (!v) return { tone: undefined, detail: 'Loading…' }
    const last = v.lastSuccessAt ? `last OK ${ago(v.lastSuccessAt, now)}` : 'never connected'
    if (v.state === 'connected') return { tone: 'ok' as const, detail: `Connected · ${last}` }
    if (v.state === 'failed') return { tone: 'bad' as const, detail: `${v.message ?? 'Failed'}` }
    if (v.state === 'untested') return { tone: 'warn' as const, detail: `Saved, not tested · ${last}` }
    return { tone: undefined, detail: 'Not configured' }
  }
  const md = health
  return (
    <Panel title="Services" flush>
      <ServiceRow
        tone={!subscription?.configured ? 'warn' : subscription.syncError ? 'bad' : subscription.lastSyncedAt ? 'ok' : undefined}
        name="Subscription server"
        detail={!subscription?.configured ? 'Not configured in this build' : subscription.syncError ?? `Synced ${ago(subscription.lastSyncedAt, now)}`}
        onClick={() => navigate('subscription')}
      />
      <ServiceRow
        tone={!md ? undefined : md.transport === 'websocket' ? 'ok' : md.transport === 'rest' ? 'warn' : 'bad'}
        name="Market data"
        detail={!md ? 'Starting…' : `${md.regionLabel} · ${md.transport === 'websocket' ? 'streaming' : md.transport === 'rest' ? 'REST polling' : 'offline'}${md.lastError ? ` · ${md.lastError}` : ''}`}
        onClick={() => navigate('settings', { tab: 'marketdata' })}
      />
      {(['delta', 'openai', 'anthropic', 'smtp', 'whatsapp'] as IntegrationId[]).map((id) => {
        const d = describe(integ(id))
        return <ServiceRow key={id} tone={d.tone} name={SERVICE_LABEL[id]} detail={d.detail} onClick={() => navigate('settings', { tab: id })} />
      })}
      <ServiceRow tone={engine?.state === 'ready' ? 'ok' : engine?.state === 'error' ? 'bad' : undefined} name="Trading engine" detail={engine?.state === 'ready' ? `Python ${engine.python} · live trading off` : (engine?.message ?? 'Starts on first backtest')} onClick={() => navigate('settings', { tab: 'about' })} />
      <ServiceRow
        tone={updates?.phase === 'error' ? 'bad' : updates?.phase === 'downloaded' ? 'warn' : updates?.phase === 'up_to_date' ? 'ok' : undefined}
        name={`Updates · v${updates?.currentVersion ?? '…'}`}
        detail={updates?.phase === 'disabled' ? 'Not configured in this build' : updates?.phase === 'downloaded' ? `v${updates.availableVersion} ready to install` : updates?.phase === 'up_to_date' ? `Up to date · checked ${ago(updates.lastCheckedAt, now)}` : (updates?.message ?? updates?.phase ?? '…')}
        onClick={() => navigate('settings', { tab: 'updates' })}
      />
    </Panel>
  )
}

function Account({ deltaState }: { deltaState: IntegrationView | undefined }) {
  const { navigate } = useApp()
  const acct = useResource(() => call('account:summary', {}), [deltaState?.state, deltaState?.config.region], { pollMs: 60_000 })
  const now = useNow(15_000)
  const a = acct.data
  return (
    <Panel
      title="Exchange account"
      actions={a?.configured ? <Button size="sm" variant="ghost" icon="refresh" loading={acct.loading} onClick={() => void call('account:summary', { refresh: true }).then(() => acct.reload())}>Refresh</Button> : undefined}
      flush
    >
      {!a ? <div className="panel-body"><Skeleton /></div> : !a.configured ? (
        <Empty icon="key" title="Not connected" action={<Button size="sm" onClick={() => navigate('settings', { tab: 'delta' })}>Connect Delta Exchange</Button>}>
          Add a read-only Delta Exchange API key to see balances and positions here. Nothing is shown until real data is available.
        </Empty>
      ) : a.error ? (
        <ErrorState message={a.error} onRetry={() => void call('account:summary', { refresh: true }).then(() => acct.reload())} />
      ) : (
        <>
          <table className="data">
            <thead><tr><th>Asset</th><th className="r">Balance</th><th className="r">Available</th></tr></thead>
            <tbody>
              {a.balances.length === 0 ? <tr><td colSpan={3} className="faint">No balances on this account.</td></tr> : a.balances.filter((b) => b.balance !== 0).slice(0, 6).map((b) => (
                <tr key={b.asset}><td className="mono">{b.asset}</td><td className="r num">{qty(b.balance)}</td><td className="r num">{b.available === null ? '—' : qty(b.available)}</td></tr>
              ))}
            </tbody>
          </table>
          {a.positions.length > 0 && (
            <table className="data">
              <thead><tr><th>Position</th><th className="r">Size</th><th className="r">Entry</th><th className="r">uPnL</th></tr></thead>
              <tbody>{a.positions.map((p) => <tr key={p.symbol}><td className="mono">{p.symbol}</td><td className={`r num ${p.size > 0 ? 'up' : 'down'}`}>{qty(p.size)}</td><td className="r num">{price(p.entryPrice)}</td><td className={`r num ${(p.unrealizedPnl ?? 0) >= 0 ? 'up' : 'down'}`}>{p.unrealizedPnl === null ? '—' : qty(p.unrealizedPnl)}</td></tr>)}</tbody>
            </table>
          )}
          <div className="faint" style={{ padding: '8px 14px', fontSize: 11.5 }}>Read-only · fetched {ago(a.fetchedAt, now)} from {a.region.replace('_', ' ')}</div>
        </>
      )}
    </Panel>
  )
}

export function Dashboard() {
  const { prefs, navigate } = useApp()
  const [symbol, setSymbol] = useState(prefs?.defaultSymbol ?? 'BTCUSD')
  const [tf, setTf] = useState<Timeframe>('1h')
  useEffect(() => {
    if (prefs?.defaultSymbol) setSymbol(prefs.defaultSymbol)
  }, [prefs?.defaultSymbol])

  const snap = useMarketWatch('dashboard', [symbol], { symbol, timeframe: tf })
  const live = useLiveSeries(symbol, tf, TF_DAYS[tf], snap?.health.connectionEpoch)
  const tickers = useResource(() => call('market:tickers', {}), [snap?.health.region], { pollMs: 15_000 })
  const integrations = useResource(() => call('integrations:list'), [])
  useEvent('integrations:progress', (p) => !p.step && void integrations.reload())
  const strategies = useResource(() => call('strategies:list'), [])
  const positions = useResource(() => call('paper:positions'), [], { pollMs: 15_000 })
  const notes = useResource(() => call('notifications:list'), [])
  const now = useNow(5000)

  const totalPnl = positions.data?.reduce((a, p) => a + (p.unrealizedPnl ?? 0) + p.realizedPnl, 0)
  const open = positions.data?.filter((p) => p.quantity !== 0).length ?? 0
  const active = strategies.data ?? []
  const quote = snap?.quotes[symbol]
  const unsupported = snap?.health.unsupported.includes(symbol)

  return (
    <div className="page">
      <div className="grid cols-4">
        <AccessTile />
        <div className="panel tile">
          <span className="label">Strategies</span>
          <span className="value">{strategies.data ? active.length : '—'}</span>
          <span className="sub">{strategies.data ? `${active.filter((s) => s.status === 'enabled').length} enabled · ${active.filter((s) => !s.validation.valid).length} need attention` : 'Loading…'}</span>
        </div>
        <div className="panel tile">
          <span className="label">Paper P&amp;L</span>
          <span className={`value ${!totalPnl ? '' : totalPnl > 0 ? 'up' : 'down'}`}>{totalPnl === undefined ? '—' : money(totalPnl, { sign: true })}</span>
          <span className="sub">{open} open position{open === 1 ? '' : 's'} · simulated</span>
        </div>
        <div className="panel tile">
          <span className="label">Selected instrument</span>
          <span className="value">{quote ? price(quote.lastPrice ?? quote.markPrice) : '—'}</span>
          <span className="sub">{symbol} last trade · {quote?.exchangeTime ? `exchange time ${new Date(quote.exchangeTime).toISOString().slice(11, 19)} UTC` : unsupported ? 'not listed in this region' : 'waiting for data'}</span>
        </div>
      </div>

      <div className="grid split">
        <Panel
          title={<span style={{ display: 'inline-flex', gap: 12, alignItems: 'center' }}>{symbol}<QuoteLine q={quote} health={snap?.health} /></span>}
          actions={<Segmented value={tf} onChange={setTf} options={(['5m', '15m', '1h', '4h', '1d'] as Timeframe[]).map((v) => ({ value: v, label: v }))} />}
        >
          {unsupported ? (
            <Empty icon="alert" title={`${symbol} is not listed on ${snap?.health.regionLabel}`} action={<Button size="sm" onClick={() => navigate('settings', { tab: 'marketdata' })}>Choose an instrument</Button>}>Instruments differ by region.</Empty>
          ) : live.error ? <ErrorState message={live.error} onRetry={live.reload} /> : !live.series ? <Skeleton height={380} /> : live.series.candles.length === 0 ? <Empty title="No candles" icon="trading">Delta Exchange returned no data for {symbol}.</Empty> : (
            <>
              <CandleChart candles={live.series.candles} height={380} />
              <div className="faint" style={{ fontSize: 11.5, display: 'flex', gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
                <span>Historical candles fetched {ago(live.series.fetchedAt, now)}</span>
                <span>{live.liveAt ? `Last candle updating live · ${ago(live.liveAt, now)}` : 'Waiting for live candle updates'}</span>
                {live.series.missing > 0 && <span title="Intervals with no trades or no exchange data are left empty, never filled in.">{live.series.missing} interval{live.series.missing === 1 ? '' : 's'} without data in range</span>}
              </div>
            </>
          )}
        </Panel>
        <Panel title="Markets" actions={<span className="faint" style={{ fontSize: 11.5 }}>REST snapshot · {tickers.data?.[0] ? `updated ${ago(tickers.data[0].updatedAt, now)}` : '…'}</span>} flush>
          {tickers.error ? <ErrorState message={tickers.error} onRetry={tickers.reload} /> : !tickers.data ? <div className="panel-body" style={{ display: 'grid', gap: 10 }}>{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} />)}</div> : (
            <table className="data">
              <thead><tr><th>Contract</th><th className="r">Mark</th><th className="r">24h</th><th className="r">Vol</th></tr></thead>
              <tbody>
                {tickers.data.slice(0, 10).map((t) => (
                  <tr key={t.symbol} className="clickable" onClick={() => setSymbol(t.symbol)} style={t.symbol === symbol ? { boxShadow: 'inset 2px 0 0 var(--accent)' } : undefined}>
                    <td className="mono">{t.symbol}</td>
                    <td className="r num">{price(t.markPrice)}</td>
                    <td className={`r num ${(t.change24hPct ?? 0) >= 0 ? 'up' : 'down'}`}>{pct(t.change24hPct)}</td>
                    <td className="r num faint">{compact(t.volume24hUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <div className="grid cols-3">
        <Services integrations={integrations.data} health={snap?.health} />
        <Account deltaState={integrations.data?.find((v) => v.id === 'delta')} />
        <Panel title="Recent backtests" actions={<Button size="sm" variant="ghost" onClick={() => navigate('analytics')}>Open analytics</Button>} flush>
          {(() => {
            const runs = active.filter((s) => s.lastBacktest).sort((a, b) => b.lastBacktest!.createdAt.localeCompare(a.lastBacktest!.createdAt)).slice(0, 5)
            if (!strategies.data) return <div className="panel-body"><Skeleton /></div>
            if (!runs.length) return <Empty icon="analytics" title="No backtests yet" action={<Button size="sm" onClick={() => navigate(active.length ? 'analytics' : 'strategies')}>{active.length ? 'Run a backtest' : 'Create a strategy'}</Button>}>Backtest a strategy to see its performance here.</Empty>
            return (
              <table className="data">
                <tbody>
                  {runs.map((s) => (
                    <tr key={s.id} className="clickable" onClick={() => navigate('analytics', { strategy: s.id })}>
                      <td><div>{s.name}</div><div className="faint" style={{ fontSize: 11.5 }}>{s.symbol} {s.timeframe}</div></td>
                      <td className={`r num ${s.lastBacktest!.metrics.totalReturnPct >= 0 ? 'up' : 'down'}`}>{pct(s.lastBacktest!.metrics.totalReturnPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          })()}
        </Panel>
      </div>

      <Panel title="Notifications" actions={<Button size="sm" variant="ghost" onClick={() => navigate('notifications')}>View all</Button>} flush>
        {!notes.data ? <div className="panel-body"><Skeleton /></div> : notes.data.length === 0 ? <Empty icon="bell" title="You're all caught up" /> : (
          notes.data.slice(0, 4).map((n) => (
            <div key={n.id} className={`notif ${n.readAt ? '' : 'unread'}`} style={{ gridTemplateColumns: '1fr auto' }}>
              <div><div className="n-title">{n.title}</div><div className="n-body">{n.body}</div></div>
              <div className="n-time">{ago(n.createdAt)}</div>
            </div>
          ))
        )}
      </Panel>
      <p className="faint" style={{ margin: 0, fontSize: 11.5, display: 'flex', gap: 8, alignItems: 'center' }}>
        <Badge tone="warn"><Icon name="lock" size={11} /> Live trading disabled</Badge> Prices: Delta Exchange. Freshness labels: Live = streaming and recent · Delayed = REST or brief gap · Stale = older than your threshold.
      </p>
    </div>
  )
}
