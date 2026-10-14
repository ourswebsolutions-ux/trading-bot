import { useState } from 'react'
import type { Strategy, StrategyInput, StrategyRisk, StrategyType, Timeframe } from '@shared/ipc'
import { PARAM_LABELS, RISK_LIMITS, STRATEGY_DESCRIPTIONS, STRATEGY_PARAMS, TIMEFRAMES } from '@shared/strategySpec'
import { PaywallBanner, useAccess } from '../components/paywall'
import { Badge, Banner, Button, ConfirmDialog, Dialog, Empty, ErrorState, Field, Panel, Skeleton, useToast } from '../components/ui'
import { call, errorMessage, fieldErrors } from '../lib/api'
import { dateTime, pct, STRATEGY_LABELS } from '../lib/format'
import { useResource } from '../lib/hooks'
import { useApp } from '../lib/state'

const RISK_LABELS: Record<keyof StrategyRisk, [string, string]> = {
  positionPct: ['Position size', '% of equity'],
  stopLossPct: ['Stop loss', '% from entry, 0 = off'],
  takeProfitPct: ['Take profit', '% from entry, 0 = off'],
  feeBps: ['Fees', 'basis points per side']
}

function defaults(type: StrategyType): Record<string, number> {
  return Object.fromEntries(Object.entries(STRATEGY_PARAMS[type]).map(([k, [, , d]]) => [k, d]))
}

function emptyInput(symbol: string): StrategyInput {
  return {
    name: '',
    symbol,
    timeframe: '1h',
    type: 'sma_cross',
    params: defaults('sma_cross'),
    risk: Object.fromEntries(Object.entries(RISK_LIMITS).map(([k, [, , d]]) => [k, d])) as unknown as StrategyRisk,
    allowShort: false,
    notes: '',
    status: 'draft'
  }
}

function NumberField({ label, hint, value, range, error, onChange }: { label: string; hint?: string; value: number; range: [number, number, number]; error?: string; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value))
  return (
    <Field label={label} hint={hint ?? `${range[0]}–${range[1]}`} error={error}>
      <input
        className={`input mono ${error ? 'invalid' : ''}`}
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          const n = Number(e.target.value)
          onChange(e.target.value.trim() === '' || !Number.isFinite(n) ? NaN : n)
        }}
      />
    </Field>
  )
}

function StrategyEditor({ strategy, symbols, onClose, onSaved }: { strategy: Strategy | null; symbols: string[]; onClose: () => void; onSaved: (s: Strategy) => void }) {
  const { prefs } = useApp()
  const [input, setInput] = useState<StrategyInput>(() =>
    strategy
      ? { name: strategy.name, symbol: strategy.symbol, timeframe: strategy.timeframe, type: strategy.type, params: strategy.params, risk: strategy.risk, allowShort: strategy.allowShort, notes: strategy.notes, status: strategy.status === 'paper' ? 'paper' : 'draft' }
      : emptyInput(prefs?.defaultSymbol ?? 'BTCUSD')
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof StrategyInput>(k: K, v: StrategyInput[K]) => setInput((i) => ({ ...i, [k]: v }))
  const symbolOptions = symbols.includes(input.symbol) ? symbols : [input.symbol, ...symbols]

  const save = async () => {
    setBusy(true)
    setError(null)
    setErrors({})
    try {
      const saved = await call('strategies:save', { id: strategy?.id, input })
      onSaved(saved)
    } catch (err) {
      setError(errorMessage(err))
      setErrors(fieldErrors(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      wide
      title={strategy ? `Edit ${strategy.name}` : 'New strategy'}
      onClose={busy ? () => {} : onClose}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} loading={busy}>{strategy ? 'Save changes' : 'Create strategy'}</Button></>}
    >
      {error && <Banner tone="bad">{error}</Banner>}
      <div className="form" style={{ color: 'var(--text)' }}>
        <div className="form-row">
          <Field label="Name" error={errors.name}>
            <input className={`input ${errors.name ? 'invalid' : ''}`} value={input.name} maxLength={80} onChange={(e) => set('name', e.target.value)} placeholder="e.g. BTC hourly trend" />
          </Field>
          <Field label="Status" hint="Paper-marked strategies are highlighted on the dashboard. Live execution is disabled.">
            <select className="select" value={input.status} onChange={(e) => set('status', e.target.value as 'draft' | 'paper')}>
              <option value="draft">Draft</option>
              <option value="paper">Paper</option>
            </select>
          </Field>
        </div>
        <div className="form-row three">
          <Field label="Market" error={errors.symbol}>
            <select className="select mono" value={input.symbol} onChange={(e) => set('symbol', e.target.value)}>
              {symbolOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Timeframe" error={errors.timeframe}>
            <select className="select" value={input.timeframe} onChange={(e) => set('timeframe', e.target.value as Timeframe)}>
              {TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Strategy type" error={errors.type}>
            <select className="select" value={input.type} onChange={(e) => { const t = e.target.value as StrategyType; setInput((i) => ({ ...i, type: t, params: defaults(t) })) }}>
              {(Object.keys(STRATEGY_PARAMS) as StrategyType[]).map((t) => <option key={t} value={t}>{STRATEGY_LABELS[t]}</option>)}
            </select>
          </Field>
        </div>
        <p className="muted" style={{ margin: 0 }}>{STRATEGY_DESCRIPTIONS[input.type]}</p>
        <div className="form-row three" key={input.type}>
          {Object.entries(STRATEGY_PARAMS[input.type]).map(([k, range]) => (
            <NumberField key={k} label={PARAM_LABELS[k] ?? k} value={input.params[k] ?? range[2]} range={range} error={errors[`params.${k}`]} onChange={(v) => set('params', { ...input.params, [k]: v })} />
          ))}
        </div>
        <div className="form-row" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          {(Object.keys(RISK_LIMITS) as (keyof StrategyRisk)[]).map((k) => (
            <NumberField key={k} label={RISK_LABELS[k][0]} hint={RISK_LABELS[k][1]} value={input.risk[k]} range={RISK_LIMITS[k]} error={errors[`risk.${k}`]} onChange={(v) => set('risk', { ...input.risk, [k]: v })} />
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={input.allowShort} onChange={(e) => set('allowShort', e.target.checked)} />
          <span>Allow short positions <span className="faint">— otherwise sell signals only close longs</span></span>
        </label>
        <Field label="Notes" error={errors.notes}>
          <textarea className="textarea" maxLength={2000} value={input.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Rationale, ideas to test, market conditions…" />
        </Field>
      </div>
    </Dialog>
  )
}

export function Strategies() {
  const toast = useToast()
  const { navigate } = useApp()
  const { allowed } = useAccess()
  const [showArchived, setShowArchived] = useState(false)
  const list = useResource(() => call('strategies:list', { includeArchived: showArchived }), [showArchived])
  const symbols = useResource(() => call('market:symbols'), [])
  const [editing, setEditing] = useState<Strategy | null | 'new'>(null)
  const [confirm, setConfirm] = useState<{ kind: 'archive' | 'delete'; s: Strategy } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const act = async (id: string, fn: () => Promise<unknown>, success: string) => {
    setBusyId(id)
    try {
      await fn()
      toast({ tone: 'ok', title: success })
      await list.reload()
    } catch (err) {
      toast({ tone: 'bad', title: 'Action failed', body: errorMessage(err) })
      throw err
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="page">
      <PaywallBanner feature="Creating, editing and backtesting strategies" />
      <Panel
        title="Strategies"
        actions={
          <>
            <label className="check" style={{ fontSize: 12, color: 'var(--text-2)' }}>
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
            </label>
            <Button variant="primary" icon="plus" onClick={() => setEditing('new')} disabled={!allowed}>New strategy</Button>
          </>
        }
        flush
      >
        {list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data ? (
          <div className="panel-body" style={{ display: 'grid', gap: 10 }}>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={18} />)}</div>
        ) : list.data.length === 0 ? (
          <Empty icon="strategies" title="No strategies yet" action={allowed ? <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>Create your first strategy</Button> : undefined}>
            A strategy combines a market, timeframe, entry rule and risk settings. You can backtest it in Analytics and paper-trade the idea in Trading.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Name</th><th>Market</th><th>Rule</th><th>Risk</th><th>Status</th><th className="r">Last backtest</th><th>Updated</th><th className="r">Actions</th></tr>
              </thead>
              <tbody>
                {list.data.map((s) => {
                  const archived = s.status === 'archived'
                  const busy = busyId === s.id
                  return (
                    <tr key={s.id} style={archived ? { opacity: 0.6 } : undefined}>
                      <td><div style={{ fontWeight: 500 }}>{s.name}</div>{s.notes && <div className="faint" style={{ fontSize: 11.5, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.notes}</div>}</td>
                      <td className="mono nowrap">{s.symbol} · {s.timeframe}</td>
                      <td className="nowrap">{STRATEGY_LABELS[s.type]} <span className="faint mono">{Object.values(s.params).join('/')}</span>{s.allowShort && <span className="faint"> · L/S</span>}</td>
                      <td className="mono nowrap faint">{s.risk.positionPct}% · SL {s.risk.stopLossPct || '—'} · TP {s.risk.takeProfitPct || '—'}</td>
                      <td>{archived ? <Badge>Archived</Badge> : s.status === 'paper' ? <Badge tone="accent">Paper</Badge> : <Badge>Draft</Badge>}</td>
                      <td className={`r num ${s.lastBacktest ? (s.lastBacktest.metrics.totalReturnPct >= 0 ? 'up' : 'down') : 'faint'}`}>{s.lastBacktest ? pct(s.lastBacktest.metrics.totalReturnPct) : '—'}</td>
                      <td className="nowrap faint">{dateTime(s.updatedAt)}</td>
                      <td className="r">
                        <div className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          {!archived && <Button size="sm" icon="play" disabled={!allowed} onClick={() => navigate('analytics', { strategy: s.id })}>Backtest</Button>}
                          {!archived && <Button size="sm" variant="ghost" icon="edit" disabled={!allowed} onClick={() => setEditing(s)}>Edit</Button>}
                          {!archived && <Button size="sm" variant="ghost" icon="copy" disabled={!allowed || busy} onClick={() => act(s.id, () => call('strategies:duplicate', { id: s.id }), 'Strategy duplicated').catch(() => undefined)}>Duplicate</Button>}
                          {!archived && <Button size="sm" variant="ghost" icon="archive" disabled={busy} onClick={() => setConfirm({ kind: 'archive', s })}>Archive</Button>}
                          {archived && <Button size="sm" icon="restore" loading={busy} onClick={() => act(s.id, () => call('strategies:restore', { id: s.id }), 'Strategy restored').catch(() => undefined)}>Restore</Button>}
                          {archived && <Button size="sm" variant="danger" icon="trash" disabled={busy} onClick={() => setConfirm({ kind: 'delete', s })}>Delete</Button>}
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

      {editing && (
        <StrategyEditor
          strategy={editing === 'new' ? null : editing}
          symbols={symbols.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={(s) => {
            toast({ tone: 'ok', title: editing === 'new' ? 'Strategy created' : 'Strategy saved', body: s.name })
            setEditing(null)
            void list.reload()
          }}
        />
      )}
      {confirm?.kind === 'archive' && (
        <ConfirmDialog title={`Archive “${confirm.s.name}”?`} confirmLabel="Archive" onClose={() => setConfirm(null)} onConfirm={() => act(confirm.s.id, () => call('strategies:archive', { id: confirm.s.id }), 'Strategy archived')}>
          Archived strategies are hidden from lists and can be restored at any time. Backtest history is kept.
        </ConfirmDialog>
      )}
      {confirm?.kind === 'delete' && (
        <ConfirmDialog title={`Delete “${confirm.s.name}” permanently?`} tone="danger" confirmLabel="Delete permanently" onClose={() => setConfirm(null)} onConfirm={() => act(confirm.s.id, () => call('strategies:delete', { id: confirm.s.id }), 'Strategy deleted')}>
          This removes the strategy and all of its backtest history. It cannot be undone.
        </ConfirmDialog>
      )}
    </div>
  )
}
