import { useEffect, useState } from 'react'
import type { AutomationMode, AutomationSessionView, Strategy, TradingOverview } from '@shared/ipc'
import { RISK_LIMITS, type TradingRiskSettings } from '@shared/tradingRisk'
import { Icon } from '../../components/icons'
import { PaywallBanner, useAccess } from '../../components/paywall'
import { Badge, Banner, Button, ConfirmDialog, Dialog, Empty, Field, Panel, PasswordInput, useToast } from '../../components/ui'
import { call, errorMessage, fieldErrors } from '../../lib/api'
import { ago, dateTime, money, price, qty } from '../../lib/format'
import { useNow } from '../../lib/hooks'
import { useApp } from '../../lib/state'

export function ModePill({ mode }: { mode: AutomationMode }) {
  return <span className={`mode-pill ${mode}`} title={mode === 'paper' ? 'Simulated: no real orders' : 'Real orders on Delta Exchange'}>{mode === 'live' ? 'Live' : 'Paper · simulated'}</span>
}

function EmergencyBar({ o, onChange }: { o: TradingOverview; onChange: (o: TradingOverview) => void }) {
  const toast = useToast()
  const [confirm, setConfirm] = useState(false)
  const [clearing, setClearing] = useState(false)
  const active = o.sessions.filter((s) => s.status !== 'stopped' || s.position).length
  if (o.emergency.active) {
    return (
      <Banner tone="bad" icon="stop" title={`Emergency stop active since ${dateTime(o.emergency.at)}`} actions={<Button size="sm" loading={clearing} onClick={async () => {
        setClearing(true)
        try {
          onChange(await call('trading:clearEmergency'))
          toast({ tone: 'ok', title: 'Emergency stop cleared', body: 'Automations stay stopped until you start them.' })
        } catch (err) {
          toast({ tone: 'bad', title: 'Could not clear', body: errorMessage(err) })
        } finally {
          setClearing(false)
        }
      }}>Clear emergency stop</Button>}>
        No new orders will be placed. {o.emergency.detail}.
      </Banner>
    )
  }
  return (
    <div className="estop">
      <Icon name="stop" size={18} style={{ color: 'var(--down)' }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600 }}>Emergency stop</div>
        <div className="muted" style={{ fontSize: 12.5 }}>
          Stops every automation and blocks new orders. Open positions are {o.risk.emergencyAction === 'close_positions' ? 'closed at market' : 'kept with their exchange-side stop-loss / take-profit'} (change this in the risk settings). {active} active automation{active === 1 ? '' : 's'}.
        </div>
      </div>
      <Button variant="danger" icon="stop" onClick={() => setConfirm(true)}>Emergency stop</Button>
      {confirm && (
        <ConfirmDialog title="Activate the emergency stop?" tone="danger" confirmLabel="Stop everything now" onClose={() => setConfirm(false)} onConfirm={async () => {
          try {
            onChange(await call('trading:emergencyStop'))
            toast({ tone: 'ok', title: 'Emergency stop active', body: 'All automation stopped.' })
          } catch (err) {
            toast({ tone: 'bad', title: 'Emergency stop needs attention', body: errorMessage(err) })
            onChange(await call('trading:overview'))
          }
        }}>
          All automations stop immediately and no new orders are sent. Open positions will be {o.risk.emergencyAction === 'close_positions' ? 'closed with reduce-only market orders' : 'left open with their stop-loss and take-profit orders on the exchange'}.
        </ConfirmDialog>
      )}
    </div>
  )
}

function LivePanel({ o, onChange }: { o: TradingOverview; onChange: (o: TradingOverview) => void }) {
  const toast = useToast()
  const { allowed } = useAccess()
  const [enabling, setEnabling] = useState(false)
  const [disabling, setDisabling] = useState(false)
  const [password, setPassword] = useState('')
  const [phrase, setPhrase] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const ready = o.live.checks.every((c) => c.ok)
  return (
    <Panel title="Live trading" actions={o.live.enabled ? <Badge tone="bad"><Icon name="bolt" size={11} /> ON</Badge> : <Badge>Off</Badge>}>
      <div style={{ display: 'grid', gap: 10 }}>
        <div className="muted" style={{ fontSize: 12.5 }}>
          {o.live.enabled
            ? `Live automations can send real orders to ${o.live.regionLabel}${o.live.testnet ? ' (testnet — demo funds)' : ' — REAL MONEY'}. Enabled ${dateTime(o.live.enabledAt)}.`
            : 'Off: automations can only run in paper mode. Live orders require every check below, your password and an explicit confirmation.'}
        </div>
        {o.live.checks.map((c) => (
          <div key={c.id} className="check-row">
            <Icon name={c.ok ? 'check' : 'alert'} size={14} style={{ color: c.ok ? 'var(--up)' : 'var(--warn)', marginTop: 2 }} />
            <div><div style={{ fontWeight: 500 }}>{c.label}</div><div className="faint" style={{ fontSize: 12 }}>{c.detail}</div></div>
          </div>
        ))}
        <div>
          {o.live.enabled ? (
            <Button icon="power" loading={disabling} onClick={async () => {
              setDisabling(true)
              try {
                onChange(await call('trading:disableLive'))
                toast({ tone: 'ok', title: 'Live trading disabled', body: 'Running live automations were paused.' })
              } catch (err) {
                toast({ tone: 'bad', title: 'Could not disable', body: errorMessage(err) })
              } finally {
                setDisabling(false)
              }
            }}>Turn live trading off</Button>
          ) : (
            <Button variant="primary" icon="bolt" disabled={!ready || !allowed} onClick={() => setEnabling(true)}>Enable live trading…</Button>
          )}
        </div>
      </div>
      {enabling && (
        <Dialog title="Enable live trading" onClose={() => !busy && setEnabling(false)} footer={
          <>
            <Button variant="ghost" onClick={() => setEnabling(false)} disabled={busy}>Cancel</Button>
            <Button variant="danger" loading={busy} disabled={phrase !== 'ENABLE LIVE TRADING' || !password} onClick={async () => {
              setBusy(true)
              setErrors({})
              try {
                onChange(await call('trading:enableLive', { password, confirmation: phrase }))
                setEnabling(false)
                toast({ tone: 'ok', title: 'Live trading enabled', body: 'Start a live automation from the strategy list.' })
              } catch (err) {
                setErrors(fieldErrors(err))
                toast({ tone: 'bad', title: 'Not enabled', body: errorMessage(err) })
              } finally {
                setBusy(false)
                setPassword('')
              }
            }}>Enable live trading</Button>
          </>
        }>
          <p style={{ margin: 0 }}>Live automations will place real market orders on <b>{o.live.regionLabel}</b>{o.live.testnet ? ' (testnet)' : ''} using your API key, with exchange-side stop-loss and take-profit orders. Risk limits are enforced on every order; nothing an AI or a strategy says can bypass them.</p>
          <p style={{ margin: 0 }}>Trading involves risk of loss. Make sure the API key only has the permissions you intend (trading enabled, withdrawals disabled).</p>
          <Field label="Type ENABLE LIVE TRADING" error={errors.confirmation}>
            <input className="input mono" value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Your TradePilot password" error={errors.password}>
            <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
        </Dialog>
      )}
    </Panel>
  )
}

const RISK_FIELDS: { key: keyof typeof RISK_LIMITS; label: string; hint: string }[] = [
  { key: 'maxOrderNotionalUsd', label: 'Max order size (USD notional)', hint: 'Orders are reduced to fit; blocked if not even one contract fits' },
  { key: 'maxExposurePct', label: 'Max total exposure (% of equity)', hint: 'Sum of open position notionals' },
  { key: 'maxOpenPositions', label: 'Max open positions', hint: 'Across all automations of the same mode' },
  { key: 'accountMaxDailyLossPct', label: 'Account daily loss limit (%)', hint: 'No new entries after this realized loss (UTC day)' },
  { key: 'paperStartingEquity', label: 'Paper account starting equity (USD)', hint: 'Used to size paper automations' },
  { key: 'paperSlippageBps', label: 'Paper slippage (bps per fill)', hint: 'Simulated fills are moved against you by this much' }
]

function RiskPanel({ o, onChange }: { o: TradingOverview; onChange: (o: TradingOverview) => void }) {
  const toast = useToast()
  const [draft, setDraft] = useState<TradingRiskSettings>(o.risk)
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(RISK_FIELDS.map((f) => [f.key, String(o.risk[f.key])])))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  useEffect(() => setDraft((d) => ({ ...d, configured: o.risk.configured })), [o.risk.configured])
  return (
    <Panel title="Account risk settings" actions={o.risk.configured ? <Badge tone="ok">Configured</Badge> : <Badge tone="warn">Required</Badge>}>
      <div className="form">
        {!o.risk.configured && <Banner tone="warn">Save these limits before starting any automation. Each strategy's own stop-loss, take-profit, sizing, daily loss and trade limits apply in addition.</Banner>}
        <div className="form-row">
          {RISK_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint} error={errors[f.key]}>
              <input className={`input mono ${errors[f.key] ? 'invalid' : ''}`} inputMode="decimal" value={text[f.key] ?? ''} onChange={(e) => {
                setText({ ...text, [f.key]: e.target.value })
                setDraft({ ...draft, [f.key]: e.target.value.trim() === '' ? Number.NaN : Number(e.target.value) })
              }} />
            </Field>
          ))}
          <Field label="Emergency stop with open positions" error={errors.emergencyAction}>
            <select className="select" value={draft.emergencyAction} onChange={(e) => setDraft({ ...draft, emergencyAction: e.target.value as TradingRiskSettings['emergencyAction'] })}>
              <option value="close_positions">Close them at market</option>
              <option value="keep_positions">Keep them with their stop-loss / take-profit</option>
            </select>
          </Field>
        </div>
        <div>
          <Button variant="primary" loading={saving} onClick={async () => {
            setSaving(true)
            setErrors({})
            try {
              onChange(await call('trading:saveRisk', draft))
              toast({ tone: 'ok', title: 'Risk settings saved' })
            } catch (err) {
              setErrors(fieldErrors(err))
              toast({ tone: 'bad', title: 'Not saved', body: errorMessage(err) })
            } finally {
              setSaving(false)
            }
          }}>Save risk settings</Button>
        </div>
      </div>
    </Panel>
  )
}

function decisionText(s: AutomationSessionView): string {
  const d = s.lastDecision
  if (!d) return 'Waiting for the next closed candle'
  if (d.blockedBy.length) return `Blocked: ${d.blockedBy.join('; ')}`
  return d.reason
}

export function AutomationTab({ o, strategies, onChange }: { o: TradingOverview; strategies: Strategy[]; onChange: (o: TradingOverview) => void }) {
  const toast = useToast()
  const { navigate } = useApp()
  const { allowed } = useAccess()
  const now = useNow(1000)
  const [busy, setBusy] = useState<string | null>(null)
  const [stopping, setStopping] = useState<AutomationSessionView | null>(null)
  const [startLive, setStartLive] = useState<Strategy | null>(null)
  const enabled = strategies.filter((s) => s.status === 'enabled')
  const sessionFor = (id: string) => o.sessions.find((s) => s.strategyId === id && s.status !== 'stopped')
  const run = async (key: string, fn: () => Promise<TradingOverview>, ok: string) => {
    setBusy(key)
    try {
      onChange(await fn())
      toast({ tone: 'ok', title: ok })
    } catch (err) {
      toast({ tone: 'bad', title: 'Not done', body: errorMessage(err) })
      throw err
    } finally {
      setBusy(null)
    }
  }
  const orphaned = o.sessions.filter((s) => s.status === 'stopped' && s.position)

  return (
    <div className="grid" style={{ gap: 16 }}>
      <PaywallBanner feature="Automated trading" />
      <EmergencyBar o={o} onChange={onChange} />
      <Panel title="Strategy automation" flush>
        {enabled.length === 0 ? (
          <Empty icon="strategies" title="No enabled strategies" action={<Button size="sm" onClick={() => navigate('strategies')}>Open strategies</Button>}>Automation runs enabled (validated) strategies. Build one and enable it first.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Strategy</th><th>Status</th><th>Position</th><th className="r">Unrealized</th><th className="r">Today</th><th>Last decision</th><th className="r">Controls</th></tr></thead>
              <tbody>
                {enabled.map((st) => {
                  const s = sessionFor(st.id)
                  const pos = s?.position
                  return (
                    <tr key={st.id}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{st.name}</div>
                        <div className="faint mono" style={{ fontSize: 11.5 }}>{st.symbol} · {st.timeframe} · {s?.strategyVersion ? `running v${s.strategyVersion}` : `v${st.version}`}</div>
                        {s && s.latestVersion !== null && s.strategyVersion !== null && s.latestVersion > s.strategyVersion && (
                          <div style={{ fontSize: 11.5, marginTop: 4 }}>
                            <span className="warn-text">v{s.latestVersion} saved, not applied.</span>{' '}
                            <Button size="sm" variant="ghost" loading={busy === `apply:${s.id}`} disabled={busy !== null || Boolean(s.position)} title={s.position ? 'The open position keeps the rules it was opened with. Apply after it closes.' : undefined} onClick={() => void run(`apply:${s.id}`, () => call('automation:applyVersion', { sessionId: s.id }), `Now running v${s.latestVersion}`).catch(() => undefined)}>Apply v{s.latestVersion}</Button>
                          </div>
                        )}
                      </td>
                      <td>
                        {s ? (
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            <ModePill mode={s.mode} />
                            <Badge tone={s.status === 'running' ? 'ok' : 'warn'}>{s.status === 'running' ? 'Running' : 'Paused'}</Badge>
                          </span>
                        ) : <span className="faint">Not running</span>}
                        {s?.warning && <div className="down" style={{ fontSize: 11.5, marginTop: 4 }}>{s.warning}</div>}
                      </td>
                      <td className="nowrap">
                        {pos ? (
                          <>
                            <div className={pos.side === 'long' ? 'up' : 'down'}>{pos.side.toUpperCase()} {qty(pos.contracts)} @ {price(pos.entryPrice)}</div>
                            <div className="faint mono" style={{ fontSize: 11.5 }}>SL {price(pos.stopPrice)} · TP {pos.takePrice ? price(pos.takePrice) : '—'}</div>
                          </>
                        ) : <span className="faint">flat</span>}
                      </td>
                      <td className={`r num ${(s?.unrealizedPnl ?? 0) >= 0 ? 'up' : 'down'}`}>{s?.unrealizedPnl === null || s?.unrealizedPnl === undefined ? '—' : money(s.unrealizedPnl, { sign: true })}</td>
                      <td className="r nowrap"><div className="num">{s ? `${s.today.trades} trade${s.today.trades === 1 ? '' : 's'}` : '—'}</div>{s && <div className={`num ${s.today.realizedPnl >= 0 ? 'up' : 'down'}`} style={{ fontSize: 11.5 }}>{money(s.today.realizedPnl, { sign: true })}</div>}</td>
                      <td style={{ maxWidth: 280 }}>
                        {s ? (
                          <>
                            <div style={{ fontSize: 12.5 }}>{decisionText(s)}</div>
                            <div className="faint" style={{ fontSize: 11.5 }}>{s.lastEvaluatedAt ? `checked ${ago(s.lastEvaluatedAt, now)}` : 'not evaluated yet'}{s.nextEvaluationAt ? ` · next ${new Date(s.nextEvaluationAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</div>
                          </>
                        ) : <span className="faint">—</span>}
                      </td>
                      <td className="r">
                        <div className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          {!s && (
                            <>
                              <Button size="sm" icon="play" loading={busy === `paper:${st.id}`} disabled={!allowed || busy !== null || o.emergency.active || !o.risk.configured} title={!o.risk.configured ? 'Save the risk settings first' : undefined} onClick={() => void run(`paper:${st.id}`, () => call('automation:start', { strategyId: st.id, mode: 'paper' }), 'Paper automation started').catch(() => undefined)}>Start paper</Button>
                              <Button size="sm" variant="danger" icon="bolt" disabled={!allowed || busy !== null || !o.live.enabled || o.emergency.active} title={!o.live.enabled ? 'Enable live trading first' : undefined} onClick={() => setStartLive(st)}>Start live</Button>
                            </>
                          )}
                          {s?.status === 'running' && <Button size="sm" icon="pause" loading={busy === `pause:${s.id}`} disabled={busy !== null} onClick={() => void run(`pause:${s.id}`, () => call('automation:pause', { sessionId: s.id }), 'Automation paused').catch(() => undefined)}>Pause</Button>}
                          {s?.status === 'paused' && <Button size="sm" icon="play" loading={busy === `resume:${s.id}`} disabled={busy !== null || o.emergency.active} onClick={() => void run(`resume:${s.id}`, () => call('automation:resume', { sessionId: s.id }), 'Automation resumed').catch(() => undefined)}>Resume</Button>}
                          {s && <Button size="sm" variant="ghost" icon="stop" disabled={busy !== null} onClick={() => setStopping(s)}>Stop</Button>}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {orphaned.length > 0 && (
        <Banner tone="warn" title="Stopped automations with open positions">
          {orphaned.map((s) => `${s.strategyName} (${s.mode}) holds ${s.position!.side} ${s.position!.contracts} ${s.symbol}`).join('; ')}. {orphaned.some((s) => s.mode === 'live') ? 'Live positions keep their exchange-side stop-loss / take-profit; manage them on Delta Exchange if needed.' : 'Paper positions are still monitored for their stop-loss / take-profit.'}
        </Banner>
      )}
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <LivePanel o={o} onChange={onChange} />
        <RiskPanel key={String(o.risk.configured)} o={o} onChange={onChange} />
      </div>
      <Panel title="Activity" actions={<span className="faint" style={{ fontSize: 11.5 }}>{o.exchange.lastReconcileAt ? `exchange reconciled ${ago(o.exchange.lastReconcileAt, now)}` : 'no live reconciliation yet'}{o.exchange.lastError ? ` · ${o.exchange.lastError}` : ''}</span>} flush>
        {o.events.length === 0 ? <Empty icon="clock" title="No activity yet" /> : (
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            {o.events.map((e) => (
              <div key={e.id} className="event-row">
                <span className="faint mono" style={{ fontSize: 11.5 }}>{dateTime(e.createdAt)}</span>
                <Icon name={e.level === 'info' ? 'info' : 'alert'} size={13} style={{ color: e.level === 'error' ? 'var(--down)' : e.level === 'warning' ? 'var(--warn)' : 'var(--text-3)', marginTop: 2 }} />
                <span>{e.message}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {stopping && (
        <Dialog title={`Stop ${stopping.strategyName}?`} onClose={() => busy === null && setStopping(null)} footer={
          <>
            <Button variant="ghost" onClick={() => setStopping(null)} disabled={busy !== null}>Cancel</Button>
            {stopping.position && <Button loading={busy === 'stop-keep'} disabled={busy !== null} onClick={() => void run('stop-keep', () => call('automation:stop', { sessionId: stopping.id, closePosition: false }), 'Automation stopped').then(() => setStopping(null)).catch(() => undefined)}>Stop, keep position</Button>}
            <Button variant="danger" loading={busy === 'stop-close'} disabled={busy !== null} onClick={() => void run('stop-close', () => call('automation:stop', { sessionId: stopping.id, closePosition: Boolean(stopping.position) }), stopping.position ? 'Stopped and position closed' : 'Automation stopped').then(() => setStopping(null)).catch(() => undefined)}>{stopping.position ? 'Stop and close position' : 'Stop automation'}</Button>
          </>
        }>
          {stopping.position
            ? <>The automation holds <b>{stopping.position.side} {stopping.position.contracts} {stopping.symbol}</b>. Close it at market now, or keep it {stopping.mode === 'live' ? 'with its exchange-side stop-loss / take-profit' : '(its stop-loss / take-profit stay monitored)'}.</>
            : 'No new orders will be placed for this strategy.'}
        </Dialog>
      )}
      {startLive && (
        <ConfirmDialog title={`Start LIVE automation for ${startLive.name}?`} tone="danger" confirmLabel="Start live automation" onClose={() => setStartLive(null)} onConfirm={() => run(`live:${startLive.id}`, () => call('automation:start', { strategyId: startLive.id, mode: 'live' }), 'Live automation started')}>
          Real market orders for <b>{startLive.symbol}</b> will be sent to {o.live.regionLabel}{o.live.testnet ? ' (testnet)' : ''} whenever the strategy's rules trigger on a closed {startLive.timeframe} candle, within your risk limits.
        </ConfirmDialog>
      )}
    </div>
  )
}
