import { useState } from 'react'
import type { Strategy } from '@shared/ipc'
import type { StrategyDefinition } from '@shared/strategyRules'
import { PaywallBanner, useAccess } from '../components/paywall'
import { Button, ConfirmDialog, Empty, ErrorState, Panel, Skeleton, useToast } from '../components/ui'
import { call, errorMessage } from '../lib/api'
import { dateTime } from '../lib/format'
import { useResource } from '../lib/hooks'
import { useApp } from '../lib/state'
import { Builder } from './strategies/Builder'
import { Details } from './strategies/Details'
import { PromptStudio } from './strategies/PromptStudio'
import { limitsSummary, riskSummary, StatusBadge } from './strategies/parts'

type Mode =
  | { kind: 'list' }
  | { kind: 'view'; id: string }
  | { kind: 'builder'; id?: string; initial?: StrategyDefinition; source?: 'manual' | 'ai'; aiProvider?: 'openai' | 'anthropic'; aiText?: string }
  | { kind: 'studio'; studio: 'create' | 'modify' | 'reprompt'; id?: string }

export function Strategies() {
  const toast = useToast()
  const { navigate } = useApp()
  const { allowed } = useAccess()
  const list = useResource(() => call('strategies:list'), [])
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [busy, setBusy] = useState<{ id: string; action: string } | null>(null)
  const [deleting, setDeleting] = useState<Strategy | null>(null)

  const act = async (s: Strategy, action: 'toggle' | 'duplicate') => {
    setBusy({ id: s.id, action })
    try {
      if (action === 'toggle') {
        const updated = await call('strategies:setEnabled', { id: s.id, enabled: s.status !== 'enabled' })
        toast({ tone: 'ok', title: updated.status === 'enabled' ? 'Strategy enabled' : 'Strategy disabled', body: updated.name })
      } else {
        const copy = await call('strategies:duplicate', { id: s.id })
        toast({ tone: 'ok', title: 'Strategy duplicated', body: copy.name })
      }
      await list.reload()
    } catch (err) {
      toast({ tone: 'bad', title: action === 'toggle' ? 'Could not change status' : 'Could not duplicate', body: errorMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  const current = mode.kind === 'view' ? list.data?.find((s) => s.id === mode.id) : undefined

  if (mode.kind === 'builder') {
    const existing = mode.id ? list.data?.find((s) => s.id === mode.id) ?? null : null
    return (
      <Builder
        key={mode.id ?? 'new'}
        strategy={existing}
        initial={mode.initial}
        source={mode.source}
        aiProvider={mode.aiProvider}
        aiText={mode.aiText}
        onClose={() => setMode(mode.id ? { kind: 'view', id: mode.id } : { kind: 'list' })}
        onSaved={(s) => {
          void list.reload()
          setMode({ kind: 'view', id: s.id })
        }}
      />
    )
  }

  if (mode.kind === 'studio') {
    const base = mode.id ? list.data?.find((s) => s.id === mode.id) : undefined
    if (mode.id && !base) return null
    return (
      <PromptStudio
        key={`${mode.studio}:${mode.id ?? 'new'}`}
        mode={base ? { kind: mode.studio === 'reprompt' ? 'reprompt' : 'modify', base } : { kind: 'create' }}
        onClose={() => setMode(mode.id ? { kind: 'view', id: mode.id } : { kind: 'list' })}
        onSaved={(s) => void list.reload().then(() => setMode({ kind: 'view', id: s.id }))}
        onAdvanced={(definition, provider, text) => setMode({ kind: 'builder', id: mode.id, initial: definition, source: 'ai', aiProvider: provider, aiText: text })}
      />
    )
  }

  const newFromPrompt = () => setMode({ kind: 'studio', studio: 'create' })

  return (
    <>
      {mode.kind === 'view' && current ? (
        <Details
          s={current}
          allowed={allowed}
          busy={busy?.id === current.id ? busy.action : null}
          onBack={() => setMode({ kind: 'list' })}
          onEdit={() => setMode({ kind: 'builder', id: current.id })}
          onModify={() => setMode({ kind: 'studio', studio: 'modify', id: current.id })}
          onReprompt={() => setMode({ kind: 'studio', studio: 'reprompt', id: current.id })}
          onChanged={() => void list.reload()}
          onDuplicate={() => void act(current, 'duplicate')}
          onToggle={() => void act(current, 'toggle')}
          onDelete={() => setDeleting(current)}
          onBacktest={() => navigate('analytics', { strategy: current.id })}
        />
      ) : (
        <div className="page">
          <PaywallBanner feature="Creating, editing, enabling and backtesting strategies" />
          <Panel
            title="Strategies"
            actions={
              <>
                <Button variant="ghost" icon="sliders" onClick={() => setMode({ kind: 'builder', source: 'manual' })} disabled={!allowed}>Advanced builder</Button>
                <Button variant="primary" icon="brain" onClick={newFromPrompt} disabled={!allowed}>New strategy from prompt</Button>
              </>
            }
            flush
          >
            {list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data ? (
              <div className="panel-body" style={{ display: 'grid', gap: 10 }}>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={18} />)}</div>
            ) : list.data.length === 0 ? (
              <Empty
                icon="strategies"
                title="No strategies yet"
                action={allowed ? <div className="btn-row" style={{ justifyContent: 'center' }}><Button variant="primary" icon="brain" onClick={newFromPrompt}>Write a strategy prompt</Button><Button variant="ghost" icon="sliders" onClick={() => setMode({ kind: 'builder', source: 'manual' })}>Build a strategy</Button></div> : undefined}
              >
                Describe your strategy in plain language: the AI proposes rules, TradePilot validates and explains them, and you confirm before anything is saved. Prefer to set every rule yourself? Use the advanced builder.
              </Empty>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Strategy</th><th>Instrument</th><th>Status</th><th>Risk</th><th>Last updated</th><th className="r">Actions</th></tr>
                  </thead>
                  <tbody>
                    {list.data.map((s) => {
                      const b = busy?.id === s.id ? busy.action : null
                      return (
                        <tr key={s.id} className="clickable" onClick={() => setMode({ kind: 'view', id: s.id })}>
                          <td>
                            <div style={{ fontWeight: 500 }}>{s.name} <span className="faint mono" style={{ fontSize: 11 }}>v{s.version}</span></div>
                            {(s.prompt || s.definition.description) && <div className="faint" style={{ fontSize: 11.5, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.prompt ? `“${s.prompt}”` : s.definition.description}</div>}
                          </td>
                          <td className="mono nowrap">{s.symbol} · {s.timeframe ?? '—'}</td>
                          <td><StatusBadge s={s} /></td>
                          <td className="nowrap"><div className="mono" style={{ fontSize: 12 }}>{riskSummary(s.definition)}</div><div className="faint" style={{ fontSize: 11.5 }}>{limitsSummary(s.definition)}</div></td>
                          <td className="nowrap faint">{dateTime(s.updatedAt)}</td>
                          <td className="r" onClick={(e) => e.stopPropagation()}>
                            <div className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                              <Button size="sm" variant="ghost" onClick={() => setMode({ kind: 'view', id: s.id })}>View</Button>
                              <Button size="sm" variant="ghost" icon="brain" disabled={!allowed || b !== null} onClick={() => setMode({ kind: 'studio', studio: 'modify', id: s.id })}>Change</Button>
                              <Button size="sm" variant="ghost" icon="copy" loading={b === 'duplicate'} disabled={!allowed || b !== null} onClick={() => void act(s, 'duplicate')}>Duplicate</Button>
                              <Button size="sm" loading={b === 'toggle'} disabled={b !== null || (s.status === 'disabled' && (!allowed || !s.validation.valid))} title={s.status === 'disabled' && !s.validation.valid ? s.validation.errors[0]?.message : undefined} onClick={() => void act(s, 'toggle')}>{s.status === 'enabled' ? 'Disable' : 'Enable'}</Button>
                              <Button size="sm" variant="ghost" icon="trash" disabled={b !== null} onClick={() => setDeleting(s)}>Delete</Button>
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
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          tone="danger"
          confirmLabel="Delete permanently"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await call('strategies:delete', { id: deleting.id })
              toast({ tone: 'ok', title: 'Strategy deleted', body: deleting.name })
              setMode({ kind: 'list' })
              await list.reload()
            } catch (err) {
              toast({ tone: 'bad', title: 'Could not delete', body: errorMessage(err) })
              throw err
            }
          }}
        >
          The strategy, its versions and its backtest history are removed from this computer. Records of trades it made are kept (with the version that produced them). This cannot be undone.
        </ConfirmDialog>
      )}
    </>
  )
}
