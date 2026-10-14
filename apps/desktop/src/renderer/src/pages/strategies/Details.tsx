import { useState } from 'react'
import type { Strategy, StrategyVersion } from '@shared/ipc'
import { Badge, Banner, Button, Empty, Panel, Skeleton, useToast } from '../../components/ui'
import { call, errorMessage } from '../../lib/api'
import { ago, dateTime, money, pct, price, qty } from '../../lib/format'
import { useEvent, useResource } from '../../lib/hooks'
import { useApp } from '../../lib/state'
import { ModePill } from '../trading/Automation'
import { ExplanationView, RulesView, StatusBadge, ValidationList } from './parts'

const SOURCE_LABEL: Record<StrategyVersion['source'], string> = { ai: 'AI prompt', manual: 'Advanced builder', converted: 'Converted template' }

function VersionRow({ v, current }: { v: StrategyVersion; current: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="version-row">
      <button type="button" className="version-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="mono">v{v.version}</span>
        {current && <Badge tone="accent">current</Badge>}
        <span className="faint">{SOURCE_LABEL[v.source]}{v.aiProvider ? ` · ${v.aiProvider === 'openai' ? 'OpenAI' : 'Claude'}` : ''}</span>
        <span className="faint" style={{ marginLeft: 'auto' }}>{dateTime(v.createdAt)}</span>
      </button>
      {v.changeRequest && <div className="prompt-quote small">Change: {v.changeRequest}</div>}
      {open && (
        <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
          {v.prompt && <div className="prompt-quote small">{v.prompt}</div>}
          <RulesView d={v.definition} />
        </div>
      )}
    </div>
  )
}

function Activity({ s }: { s: Strategy }) {
  const activity = useResource(() => call('strategies:activity', { id: s.id }), [s.id, s.version])
  useEvent('trading:changed', () => void activity.reload())
  if (activity.error) return <Banner tone="bad">{activity.error}</Banner>
  if (!activity.data) return <Skeleton height={80} />
  const { sessions, trades, events } = activity.data
  if (!sessions.length) return <Empty icon="trading" title="Not run yet">Start paper trading to see signals, positions and results here. Paper trading is simulated and places no real orders.</Empty>
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="table-wrap">
        <table className="data compact">
          <thead><tr><th>Automation</th><th>Version</th><th>Position</th><th className="r">Unrealized</th><th className="r">Closed trades</th><th>Last signal check</th></tr></thead>
          <tbody>
            {sessions.map((x) => (
              <tr key={x.id}>
                <td className="nowrap"><span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><ModePill mode={x.mode} /><Badge tone={x.status === 'running' ? 'ok' : x.status === 'paused' ? 'warn' : undefined}>{x.status}</Badge></span><div className="faint" style={{ fontSize: 11.5 }}>since {dateTime(x.startedAt)}</div></td>
                <td className="mono nowrap">v{x.strategyVersion ?? '?'}{x.latestVersion && x.strategyVersion && x.latestVersion > x.strategyVersion && x.status !== 'stopped' ? <div className="warn-text" style={{ fontSize: 11.5 }}>v{x.latestVersion} not applied</div> : null}</td>
                <td className="nowrap">{x.position ? <><div className={x.position.side === 'long' ? 'up' : 'down'}>{x.position.side.toUpperCase()} {qty(x.position.contracts)} @ {price(x.position.entryPrice)}</div><div className="faint mono" style={{ fontSize: 11.5 }}>SL {price(x.position.stopPrice)} · TP {x.position.takePrice ? price(x.position.takePrice) : '—'}</div></> : <span className="faint">flat</span>}</td>
                <td className={`r num ${(x.unrealizedPnl ?? 0) >= 0 ? 'up' : 'down'}`}>{x.unrealizedPnl == null ? '—' : money(x.unrealizedPnl, { sign: true })}</td>
                <td className="r num">{x.totals.trades} · <span className={x.totals.netPnl >= 0 ? 'up' : 'down'}>{money(x.totals.netPnl, { sign: true })}</span></td>
                <td style={{ maxWidth: 300, fontSize: 12.5 }}>{x.lastDecision ? <>{x.lastDecision.blockedBy.length ? `Blocked: ${x.lastDecision.blockedBy.join('; ')}` : x.lastDecision.reason}<div className="faint" style={{ fontSize: 11.5 }}>{ago(x.lastDecision.at)}</div></> : <span className="faint">waiting for a closed candle</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div>
          <div className="panel-title" style={{ marginBottom: 6 }}>Recent signals and events</div>
          {events.length === 0 ? <div className="faint">None yet.</div> : (
            <ul className="event-list">
              {events.slice(0, 15).map((e) => <li key={e.id} className={e.level}><span className="faint mono">{new Date(e.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span> {e.message}</li>)}
            </ul>
          )}
        </div>
        <div>
          <div className="panel-title" style={{ marginBottom: 6 }}>Execution results</div>
          {trades.length === 0 ? <div className="faint">No closed trades yet.</div> : (
            <table className="data compact">
              <thead><tr><th>Closed</th><th>Mode</th><th>Ver.</th><th>Side</th><th className="r">Entry → exit</th><th className="r">Net</th></tr></thead>
              <tbody>
                {trades.slice(0, 15).map((t) => (
                  <tr key={t.id}>
                    <td className="nowrap faint">{dateTime(t.exitTime)}</td>
                    <td><ModePill mode={t.mode} /></td>
                    <td className="mono">v{t.strategyVersion ?? '?'}</td>
                    <td className={t.side === 'long' ? 'up' : 'down'}>{t.side.toUpperCase()}</td>
                    <td className="r num nowrap">{price(t.entryPrice)} → {price(t.exitPrice)}<div className="faint" style={{ fontSize: 11 }}>{t.exitReason.replace(/_/g, ' ')}</div></td>
                    <td className={`r num ${t.netPnl >= 0 ? 'up' : 'down'}`}>{money(t.netPnl, { sign: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

export function Details({ s, busy, onBack, onEdit, onModify, onReprompt, onDuplicate, onToggle, onDelete, onBacktest, onChanged, allowed }: {
  s: Strategy
  busy: string | null
  allowed: boolean
  onBack: () => void
  onEdit: () => void
  onModify: () => void
  onReprompt: () => void
  onDuplicate: () => void
  onToggle: () => void
  onDelete: () => void
  onBacktest: () => void
  onChanged: () => void
}) {
  const toast = useToast()
  const { navigate } = useApp()
  const versions = useResource(() => call('strategies:versions', { id: s.id }), [s.id, s.version])
  const [starting, setStarting] = useState(false)
  const m = s.lastBacktest?.metrics

  const startPaper = async () => {
    setStarting(true)
    try {
      await call('automation:start', { strategyId: s.id, mode: 'paper' })
      toast({ tone: 'ok', title: 'Paper trading started', body: 'Simulated orders only. Results appear below and on the Trading page.' })
      onChanged()
    } catch (err) {
      toast({ tone: 'bad', title: 'Paper trading not started', body: errorMessage(err) })
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="page">
      <Panel
        title={<span style={{ display: 'inline-flex', gap: 10, alignItems: 'center', textTransform: 'none', letterSpacing: 0, fontSize: 14, color: 'var(--text)' }}>{s.name} <span className="faint mono" style={{ fontSize: 12 }}>v{s.version}</span> <StatusBadge s={s} /></span>}
        actions={<Button size="sm" variant="ghost" onClick={onBack}>Back to strategies</Button>}
      >
        <div style={{ display: 'grid', gap: 12 }}>
          {s.definition.description && <p className="muted" style={{ margin: 0 }}>{s.definition.description}</p>}
          {s.source === 'ai' && <Banner tone="info" icon="brain">Rules interpreted by AI ({s.aiProvider === 'openai' ? 'OpenAI' : 'Anthropic Claude'}) from your prompt and confirmed by you. They are not verified trading logic; backtest and paper trade before relying on them.</Banner>}
          {s.source === 'converted' && <Banner tone="info">Converted from an earlier template strategy. Review the rules and set the daily limits before enabling.</Banner>}
          {s.status === 'enabled' && <Banner tone="ok" title="Enabled">This strategy passed validation. Enabling places no orders: start paper trading (simulated) here, or paper/live automation on the Trading page.</Banner>}
          <div className="btn-row">
            <Button variant="primary" icon="brain" disabled={!allowed || busy !== null} onClick={onModify}>Change with a prompt</Button>
            {s.prompt && <Button icon="refresh" disabled={!allowed || busy !== null} onClick={onReprompt}>Revise original prompt</Button>}
            <Button icon={s.status === 'enabled' ? 'lock' : 'check'} loading={busy === 'toggle'} disabled={busy !== null || (s.status === 'disabled' && (!s.validation.valid || !allowed))} onClick={onToggle}>{s.status === 'enabled' ? 'Disable' : 'Enable'}</Button>
            <Button icon="analytics" disabled={!allowed || !s.validation.valid || busy !== null} onClick={onBacktest}>Backtest</Button>
            <Button icon="play" loading={starting} disabled={!allowed || s.status !== 'enabled' || busy !== null || starting} title={s.status !== 'enabled' ? 'Enable the strategy first' : undefined} onClick={() => void startPaper()}>Start paper trading</Button>
            <Button icon="sliders" variant="ghost" disabled={!allowed || busy !== null} onClick={onEdit}>Advanced edit</Button>
            <Button icon="copy" variant="ghost" loading={busy === 'duplicate'} disabled={!allowed || busy !== null} onClick={onDuplicate}>Duplicate</Button>
            <Button icon="trash" variant="danger" disabled={busy !== null} onClick={onDelete}>Delete</Button>
          </div>
        </div>
      </Panel>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="grid" style={{ gap: 16 }}>
          <Panel title="Your prompt">
            {s.prompt ? <div className="prompt-quote">{s.prompt}</div> : <div className="faint">This strategy was built in the advanced builder, without a prompt.</div>}
          </Panel>
          <Panel title="How TradePilot executes it"><ExplanationView d={s.definition} /></Panel>
          <Panel title="Validation"><ValidationList v={s.validation} /></Panel>
        </div>
        <div className="grid" style={{ gap: 16 }}>
          <Panel title="Interpreted rules"><RulesView d={s.definition} /></Panel>
          <Panel title="History">
            <dl className="kv" style={{ gridTemplateColumns: '150px 1fr' }}>
              <dt>Created</dt><dd>{dateTime(s.createdAt)}</dd>
              <dt>Last updated</dt><dd>{dateTime(s.updatedAt)}</dd>
              <dt>Enabled since</dt><dd>{s.enabledAt ? dateTime(s.enabledAt) : '—'}</dd>
              <dt>Last backtest</dt>
              <dd>{m ? <>{dateTime(s.lastBacktest!.createdAt)} · <span className={m.totalReturnPct >= 0 ? 'up' : 'down'}>{pct(m.totalReturnPct)}</span> · {m.trades} trades · max DD {pct(-m.maxDrawdownPct, 2, false)}{m.slippageBps !== undefined ? ` · ${m.slippageBps} bps slippage` : ''} <Badge tone="info">simulated</Badge></> : <Badge>none yet</Badge>}</dd>
            </dl>
          </Panel>
        </div>
      </div>

      <Panel title="Signals, positions and results" actions={<Button size="sm" variant="ghost" onClick={() => navigate('trading')}>Open Trading</Button>}>
        <Activity s={s} />
      </Panel>

      <Panel title={`Versions (${versions.data?.length ?? '…'})`}>
        {versions.error ? <Banner tone="bad">{versions.error}</Banner> : !versions.data ? <Skeleton height={40} /> : (
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="faint" style={{ fontSize: 12 }}>Every confirmed change is kept as a version. Automations run the version they were started with, and each trade records the version that produced it.</div>
            {versions.data.map((v) => <VersionRow key={v.version} v={v} current={v.version === s.version} />)}
          </div>
        )}
      </Panel>
    </div>
  )
}
