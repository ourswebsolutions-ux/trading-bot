import { useEffect, useMemo, useState } from 'react'
import type { Strategy, Timeframe } from '@shared/ipc'
import {
  COMPARATORS,
  COMPARATOR_TEXT,
  INDICATORS,
  LIMITS,
  TIMEFRAMES,
  emptyDefinition,
  suggestIndicatorId,
  type Comparator,
  type Condition,
  type IndicatorDef,
  type IndicatorKind,
  type Operand,
  type RuleGroup,
  type Sizing,
  type StopLoss,
  type StrategyDefinition,
  type TakeProfit,
  type ValidationResult
} from '@shared/strategyRules'
import { PaywallBanner, useAccess } from '../../components/paywall'
import { Banner, Button, Field, Panel, Segmented, useToast } from '../../components/ui'
import { call, errorMessage, fieldErrors } from '../../lib/api'
import { useResource } from '../../lib/hooks'
import { useApp } from '../../lib/state'
import { ExplanationView, ValidationList } from './parts'

/** Number input that keeps what the user typed (e.g. "1.") while reporting a parsed value or null. */
function NumInput({ value, onChange, invalid, placeholder }: { value: number | null | undefined; onChange: (v: number | null) => void; invalid?: boolean; placeholder?: string }) {
  const [text, setText] = useState(value === null || value === undefined || Number.isNaN(value) ? '' : String(value))
  useEffect(() => {
    const parsed = text.trim() === '' ? null : Number(text)
    if (parsed !== value && !(Number.isNaN(parsed) && Number.isNaN(value))) setText(value === null || value === undefined || Number.isNaN(value) ? '' : String(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return (
    <input
      className={`input mono ${invalid ? 'invalid' : ''}`}
      inputMode="decimal"
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const t = e.target.value.trim()
        onChange(t === '' ? null : Number(t))
      }}
    />
  )
}

function OperandPicker({ value, onChange, d, invalid }: { value: Operand; onChange: (o: Operand) => void; d: StrategyDefinition; invalid?: boolean }) {
  const key = value.type === 'indicator' ? `i:${value.id}` : value.type === 'price' ? `p:${value.field}` : 'v'
  return (
    <div className={`operand ${value.type === 'value' ? '' : 'single'}`}>
      <select
        className={`select ${invalid ? 'invalid' : ''}`}
        value={key}
        aria-label="Operand"
        onChange={(e) => {
          const k = e.target.value
          if (k === 'v') onChange({ type: 'value', value: value.type === 'value' ? value.value : Number.NaN })
          else if (k.startsWith('p:')) onChange({ type: 'price', field: k.slice(2) as 'close' })
          else onChange({ type: 'indicator', id: k.slice(2) })
        }}
      >
        <optgroup label="Price">
          {(['close', 'open', 'high', 'low'] as const).map((f) => <option key={f} value={`p:${f}`}>{f[0]!.toUpperCase() + f.slice(1)} price</option>)}
        </optgroup>
        <optgroup label="Indicators">
          {d.indicators.map((i) => <option key={i.id} value={`i:${i.id}`}>{i.id} — {INDICATORS[i.kind]?.label}</option>)}
          {value.type === 'indicator' && !d.indicators.some((i) => i.id === value.id) && <option value={key}>{value.id || '?'} (undefined)</option>}
        </optgroup>
        <option value="v">Number…</option>
      </select>
      {value.type === 'value' && <NumInput value={value.value} invalid={invalid} placeholder="value" onChange={(n) => onChange({ type: 'value', value: n ?? Number.NaN })} />}
    </div>
  )
}

function GroupEditor({ title, hint, group, onChange, d, errorsAt, optional }: {
  title: string
  hint: string
  group: RuleGroup | null
  onChange: (g: RuleGroup | null) => void
  d: StrategyDefinition
  errorsAt: (prefix: string) => string[]
  optional?: boolean
}) {
  const g = group ?? { match: 'all' as const, conditions: [] }
  const defaultCondition = (): Condition => {
    const first = d.indicators[0]
    return { left: first ? { type: 'indicator', id: first.id } : { type: 'price', field: 'close' }, op: '<', right: { type: 'value', value: Number.NaN } }
  }
  const setCond = (i: number, c: Condition) => onChange({ ...g, conditions: g.conditions.map((x, j) => (j === i ? c : x)) })
  const groupErrors = errorsAt('')
  return (
    <div className="group-box">
      <div className="group-head">
        <span className="panel-title">{title}</span>
        {g.conditions.length > 1 && (
          <Segmented value={g.match} onChange={(m) => onChange({ ...g, match: m })} options={[{ value: 'all', label: 'All true' }, { value: 'any', label: 'Any true' }]} />
        )}
      </div>
      {g.conditions.length === 0 && <div className="faint" style={{ fontSize: 12.5 }}>{hint}</div>}
      {g.conditions.map((c, i) => {
        const rowErrors = errorsAt(`.conditions.${i}`)
        return (
          <div key={i} className="cond-row">
            <OperandPicker value={c.left} d={d} invalid={errorsAt(`.conditions.${i}.left`).length > 0} onChange={(o) => setCond(i, { ...c, left: o })} />
            <select className="select" value={c.op} aria-label="Comparison" onChange={(e) => setCond(i, { ...c, op: e.target.value as Comparator })}>
              {COMPARATORS.map((op) => <option key={op} value={op}>{COMPARATOR_TEXT[op]}</option>)}
            </select>
            <OperandPicker value={c.right} d={d} invalid={errorsAt(`.conditions.${i}.right`).length > 0} onChange={(o) => setCond(i, { ...c, right: o })} />
            <button className="icon-btn" aria-label="Remove condition" onClick={() => {
              const conditions = g.conditions.filter((_, j) => j !== i)
              onChange(conditions.length === 0 && optional ? null : { ...g, conditions })
            }}>×</button>
            {rowErrors.map((e, k) => <div key={k} className="row-error">{e}</div>)}
          </div>
        )
      })}
      {groupErrors.map((e, k) => <div key={k} className="row-error">{e}</div>)}
      <div>
        <Button size="sm" icon="plus" disabled={g.conditions.length >= LIMITS.conditionsPerGroup} onClick={() => onChange({ ...g, conditions: [...g.conditions, defaultCondition()] })}>Add condition</Button>
      </div>
    </div>
  )
}

const STOP_TYPES: { value: StopLoss['type']; label: string; unit: string }[] = [
  { value: 'percent', label: 'Percent of entry price', unit: '%' },
  { value: 'points', label: 'Price points', unit: 'pts' },
  { value: 'atr', label: 'Multiple of ATR(14)', unit: '× ATR' }
]
const TARGET_TYPES: { value: TakeProfit['type']; label: string }[] = [
  { value: 'percent', label: 'Percent of entry price' },
  { value: 'points', label: 'Price points' },
  { value: 'risk_multiple', label: 'Multiple of stop distance (R)' }
]
const SIZING_TYPES: { value: Sizing['type']; label: string }[] = [
  { value: 'percent_equity', label: 'Percent of equity' },
  { value: 'risk_percent', label: 'Risk % of equity at the stop' },
  { value: 'fixed_quantity', label: 'Fixed quantity (contracts)' }
]

export function Builder({ strategy, initial, source, aiProvider, aiText, onClose, onSaved }: {
  strategy: Strategy | null
  initial?: StrategyDefinition
  source?: 'manual' | 'ai'
  aiProvider?: 'openai' | 'anthropic'
  /** The prompt (new strategy) or change request (existing one) the initial rules came from. */
  aiText?: string
  onClose: () => void
  onSaved: (s: Strategy) => void
}) {
  const toast = useToast()
  const { prefs } = useApp()
  const { allowed } = useAccess()
  const [d, setD] = useState<StrategyDefinition>(() => structuredClone(initial ?? strategy?.definition ?? emptyDefinition(prefs?.defaultSymbol ?? 'BTCUSD')))
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [saving, setSaving] = useState<null | 'save' | 'enable'>(null)
  const [error, setError] = useState<string | null>(null)
  const instruments = useResource(() => call('market:instruments', {}), [])
  const set = <K extends keyof StrategyDefinition>(k: K, val: StrategyDefinition[K]) => setD((x) => ({ ...x, [k]: val }))
  const setRisk = <K extends keyof StrategyDefinition['risk']>(k: K, val: StrategyDefinition['risk'][K]) => setD((x) => ({ ...x, risk: { ...x.risk, [k]: val } }))

  // live validation by the main process (same rules that gate enabling, incl. the region's instruments)
  useEffect(() => {
    const t = setTimeout(() => {
      void call('strategies:validate', { definition: d }).then(setValidation).catch(() => undefined)
    }, 250)
    return () => clearTimeout(t)
  }, [d])

  const errorsAt = (prefix: string) => (validation?.errors ?? []).filter((e) => e.path === prefix).map((e) => e.message)
  const errorsUnder = (prefix: string) => (suffix: string) => errorsAt(prefix + suffix)
  const fieldErr = (p: string) => errorsAt(p)[0]
  const long = d.direction === 'long' || d.direction === 'both'
  const short = d.direction === 'short' || d.direction === 'both'

  const setIndicator = (i: number, patch: Partial<IndicatorDef>) => {
    setD((x) => {
      const old = x.indicators[i]!
      const next = { ...old, ...patch }
      if (patch.kind) {
        const spec = INDICATORS[patch.kind]
        next.period = spec.period[2]
        if (spec.stdDev) next.stdDev = next.stdDev ?? spec.stdDev[2]
        else delete next.stdDev
      }
      const renamed = next.id !== old.id
      const fix = (g: RuleGroup | null): RuleGroup | null =>
        g && renamed ? { ...g, conditions: g.conditions.map((c) => ({ ...c, left: c.left.type === 'indicator' && c.left.id === old.id ? { type: 'indicator', id: next.id } : c.left, right: c.right.type === 'indicator' && c.right.id === old.id ? { type: 'indicator', id: next.id } : c.right })) } : g
      return { ...x, indicators: x.indicators.map((y, j) => (j === i ? next : y)), entry: { long: fix(x.entry.long), short: fix(x.entry.short) }, exit: { long: fix(x.exit.long), short: fix(x.exit.short) } }
    })
  }

  const save = async (enable: boolean) => {
    setSaving(enable ? 'enable' : 'save')
    setError(null)
    try {
      const fromAi = source === 'ai' && aiProvider
      let saved = await call('strategies:save', {
        id: strategy?.id,
        definition: d,
        source: fromAi ? 'ai' : 'manual',
        aiProvider: fromAi ? aiProvider : undefined,
        ...(fromAi && aiText ? (strategy ? { changeRequest: `${aiText}\n\n(then edited in the advanced builder)` } : { prompt: aiText }) : {})
      })
      if (enable) saved = await call('strategies:setEnabled', { id: saved.id, enabled: true })
      toast({ tone: 'ok', title: enable ? 'Strategy saved and enabled' : strategy ? 'Strategy saved' : 'Strategy created', body: saved.name })
      onSaved(saved)
    } catch (err) {
      setError(errorMessage(err))
      const f = fieldErrors(err)
      if (f.name) toast({ tone: 'bad', title: 'Not saved', body: f.name })
    } finally {
      setSaving(null)
    }
  }

  const symbolOptions = useMemo(() => {
    const list = instruments.data?.map((i) => i.symbol) ?? []
    return d.symbol && !list.includes(d.symbol) ? [d.symbol, ...list] : list
  }, [instruments.data, d.symbol])

  return (
    <div className="page">
      <PaywallBanner feature="Creating and editing strategies" />
      {source === 'ai' && (
        <Banner tone="info" icon="brain" title="AI-interpreted rules">These rules were proposed by AI from your description. Check every value; nothing is saved until you choose Save.</Banner>
      )}
      {strategy && <Banner tone="info">Saving changes creates version {strategy.version + 1}. Running automations keep their current version (and open positions keep their rules) until you apply the new version on the Trading page.</Banner>}
      <div className="builder">
        <div className="grid" style={{ gap: 16 }}>
          <Panel title={strategy ? `Advanced edit · ${strategy.name} v${strategy.version}` : 'Advanced builder'} actions={<Button size="sm" variant="ghost" onClick={onClose}>Back to strategies</Button>}>
            <div className="form">
              <div className="form-row">
                <Field label="Name" error={fieldErr('name')}>
                  <input className={`input ${fieldErr('name') ? 'invalid' : ''}`} value={d.name} maxLength={80} onChange={(e) => set('name', e.target.value)} placeholder="e.g. BTC RSI dip buyer" />
                </Field>
                <Field label="Instrument" error={fieldErr('symbol')} hint={instruments.error ?? 'Live perpetuals in your Delta Exchange region'}>
                  <select className={`select mono ${fieldErr('symbol') ? 'invalid' : ''}`} value={d.symbol} onChange={(e) => set('symbol', e.target.value)}>
                    {!d.symbol && <option value="">Choose…</option>}
                    {symbolOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Description" error={fieldErr('description')}>
                <textarea className="textarea" rows={2} maxLength={2000} value={d.description} onChange={(e) => set('description', e.target.value)} placeholder="What the strategy is meant to capture" />
              </Field>
              <div className="form-row">
                <Field group label="Timeframe" error={fieldErr('timeframe')}>
                  <Segmented value={(d.timeframe ?? '') as Timeframe} onChange={(t) => set('timeframe', t)} options={TIMEFRAMES.map((t) => ({ value: t, label: t }))} />
                </Field>
                <Field group label="Direction" error={fieldErr('direction')}>
                  <Segmented value={d.direction ?? ('' as 'long')} onChange={(dir) => setD((x) => ({ ...x, direction: dir, entry: { long: dir === 'short' ? null : (x.entry.long ?? { match: 'all', conditions: [] }), short: dir === 'long' ? null : (x.entry.short ?? { match: 'all', conditions: [] }) }, exit: { long: dir === 'short' ? null : x.exit.long, short: dir === 'long' ? null : x.exit.short } }))}
                    options={[{ value: 'long', label: 'Buy (long)' }, { value: 'short', label: 'Sell short' }, { value: 'both', label: 'Both' }]} />
                </Field>
              </div>
            </div>
          </Panel>

          <Panel title="Indicators" actions={<Button size="sm" icon="plus" disabled={d.indicators.length >= LIMITS.indicators} onClick={() => setD((x) => ({ ...x, indicators: [...x.indicators, { id: suggestIndicatorId('rsi', 14, x.indicators.map((i) => i.id)), kind: 'rsi', period: 14 }] }))}>Add indicator</Button>}>
            {d.indicators.length === 0 ? <div className="faint">No indicators yet. Add the indicators your rules compare (rules can also use prices and fixed numbers).</div> : (
              <div style={{ display: 'grid', gap: 8 }}>
                <div className="ind-row faint" style={{ fontSize: 11.5 }}><span>Indicator</span><span>Period</span><span>Width (σ)</span><span>Name used in rules</span><span /></div>
                {d.indicators.map((ind, i) => {
                  const spec = INDICATORS[ind.kind]
                  const errs = [...errorsAt(`indicators.${i}.kind`), ...errorsAt(`indicators.${i}.period`), ...errorsAt(`indicators.${i}.stdDev`), ...errorsAt(`indicators.${i}.id`)]
                  return (
                    <div key={i} className="ind-row">
                      <select className="select" value={ind.kind} onChange={(e) => setIndicator(i, { kind: e.target.value as IndicatorKind })} aria-label="Indicator type">
                        {(Object.keys(INDICATORS) as IndicatorKind[]).map((k) => <option key={k} value={k}>{INDICATORS[k].label}</option>)}
                      </select>
                      <NumInput value={ind.period} invalid={errorsAt(`indicators.${i}.period`).length > 0} onChange={(n) => setIndicator(i, { period: n ?? Number.NaN })} />
                      {spec?.stdDev ? <NumInput value={ind.stdDev ?? null} invalid={errorsAt(`indicators.${i}.stdDev`).length > 0} onChange={(n) => setIndicator(i, { stdDev: n ?? Number.NaN })} /> : <span className="faint" style={{ alignSelf: 'center' }}>—</span>}
                      <input className={`input mono ${errorsAt(`indicators.${i}.id`).length ? 'invalid' : ''}`} value={ind.id} maxLength={24} onChange={(e) => setIndicator(i, { id: e.target.value.toLowerCase() })} aria-label="Indicator name" />
                      <button className="icon-btn" aria-label="Remove indicator" onClick={() => setD((x) => ({ ...x, indicators: x.indicators.filter((_, j) => j !== i) }))}>×</button>
                      {errs.map((e, k) => <div key={k} className="row-error">{e}</div>)}
                    </div>
                  )
                })}
              </div>
            )}
          </Panel>

          <Panel title="Entry rules (buy / sell)">
            <div style={{ display: 'grid', gap: 12 }}>
              {!d.direction && <div className="faint">Choose a direction first.</div>}
              {long && <GroupEditor title="Buy (open long) when" hint="Add the conditions that must be met to buy." group={d.entry.long} d={d} errorsAt={errorsUnder('entry.long')} onChange={(g) => setD((x) => ({ ...x, entry: { ...x.entry, long: g } }))} />}
              {short && <GroupEditor title="Sell short (open short) when" hint="Add the conditions that must be met to sell short." group={d.entry.short} d={d} errorsAt={errorsUnder('entry.short')} onChange={(g) => setD((x) => ({ ...x, entry: { ...x.entry, short: g } }))} />}
            </div>
          </Panel>

          <Panel title="Exit rules (optional)">
            <div style={{ display: 'grid', gap: 12 }}>
              <div className="faint" style={{ fontSize: 12.5 }}>Positions always close at the stop-loss or take-profit. Add rules here to close earlier when conditions change.</div>
              {long && <GroupEditor optional title="Close long when" hint="No rule-based exit for long positions." group={d.exit.long} d={d} errorsAt={errorsUnder('exit.long')} onChange={(g) => setD((x) => ({ ...x, exit: { ...x.exit, long: g } }))} />}
              {short && <GroupEditor optional title="Close short when" hint="No rule-based exit for short positions." group={d.exit.short} d={d} errorsAt={errorsUnder('exit.short')} onChange={(g) => setD((x) => ({ ...x, exit: { ...x.exit, short: g } }))} />}
            </div>
          </Panel>

          <Panel title="Risk management">
            <div className="form">
              <div className="form-row">
                <Field label="Stop-loss" error={fieldErr('risk.stopLoss') ?? fieldErr('risk.stopLoss.type')}>
                  <select className={`select ${fieldErr('risk.stopLoss') ? 'invalid' : ''}`} value={d.risk.stopLoss?.type ?? ''} onChange={(e) => setRisk('stopLoss', e.target.value ? { type: e.target.value as StopLoss['type'], value: d.risk.stopLoss?.value ?? Number.NaN } : null)}>
                    <option value="">Choose…</option>
                    {STOP_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </Field>
                <Field label={`Stop distance${d.risk.stopLoss ? ` (${STOP_TYPES.find((t) => t.value === d.risk.stopLoss!.type)!.unit})` : ''}`} error={fieldErr('risk.stopLoss.value')}>
                  <NumInput value={d.risk.stopLoss?.value ?? null} invalid={!!fieldErr('risk.stopLoss.value')} onChange={(n) => d.risk.stopLoss && setRisk('stopLoss', { ...d.risk.stopLoss, value: n ?? Number.NaN })} />
                </Field>
                <Field label="Take-profit" error={fieldErr('risk.takeProfit.type')} hint="Optional">
                  <select className="select" value={d.risk.takeProfit?.type ?? ''} onChange={(e) => setRisk('takeProfit', e.target.value ? { type: e.target.value as TakeProfit['type'], value: d.risk.takeProfit?.value ?? Number.NaN } : null)}>
                    <option value="">None</option>
                    {TARGET_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </Field>
                <Field label="Take-profit distance" error={fieldErr('risk.takeProfit.value')}>
                  <NumInput value={d.risk.takeProfit?.value ?? null} invalid={!!fieldErr('risk.takeProfit.value')} onChange={(n) => d.risk.takeProfit && setRisk('takeProfit', { ...d.risk.takeProfit, value: n ?? Number.NaN })} />
                </Field>
                <Field label="Position sizing" error={fieldErr('risk.sizing') ?? fieldErr('risk.sizing.type')}>
                  <select className={`select ${fieldErr('risk.sizing') ? 'invalid' : ''}`} value={d.risk.sizing?.type ?? ''} onChange={(e) => setRisk('sizing', e.target.value ? { type: e.target.value as Sizing['type'], value: d.risk.sizing?.value ?? Number.NaN } : null)}>
                    <option value="">Choose…</option>
                    {SIZING_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </Field>
                <Field label="Size" error={fieldErr('risk.sizing.value')}>
                  <NumInput value={d.risk.sizing?.value ?? null} invalid={!!fieldErr('risk.sizing.value')} onChange={(n) => d.risk.sizing && setRisk('sizing', { ...d.risk.sizing, value: n ?? Number.NaN })} />
                </Field>
                <Field label="Maximum daily loss (% of equity)" error={fieldErr('risk.maxDailyLossPct')}>
                  <NumInput value={d.risk.maxDailyLossPct} invalid={!!fieldErr('risk.maxDailyLossPct')} onChange={(n) => setRisk('maxDailyLossPct', n)} />
                </Field>
                <Field label="Maximum daily loss (USD)" error={fieldErr('risk.maxDailyLossUsd')} hint="Optional; set this, the percent limit, or both">
                  <NumInput value={d.risk.maxDailyLossUsd ?? null} invalid={!!fieldErr('risk.maxDailyLossUsd')} onChange={(n) => setRisk('maxDailyLossUsd', n)} />
                </Field>
                <Field label="Allocated capital (USD)" error={fieldErr('risk.allocatedCapitalUsd')} hint="Optional; base for percent sizing">
                  <NumInput value={d.risk.allocatedCapitalUsd ?? null} invalid={!!fieldErr('risk.allocatedCapitalUsd')} onChange={(n) => setRisk('allocatedCapitalUsd', n)} />
                </Field>
                <Field label="Maximum trades per day" error={fieldErr('risk.maxTradesPerDay')}>
                  <NumInput value={d.risk.maxTradesPerDay} invalid={!!fieldErr('risk.maxTradesPerDay')} onChange={(n) => setRisk('maxTradesPerDay', n)} />
                </Field>
                <Field label="Fee assumption (bps per side)" error={fieldErr('risk.feeBps')} hint="Used by backtests only">
                  <NumInput value={d.risk.feeBps} invalid={!!fieldErr('risk.feeBps')} onChange={(n) => setRisk('feeBps', n ?? Number.NaN)} />
                </Field>
              </div>
            </div>
          </Panel>
        </div>

        <div className="builder-side">
          <Panel title="Validation">
            <ValidationList v={validation} />
          </Panel>
          <Panel title="How this strategy works">
            <ExplanationView d={d} />
          </Panel>
          <Panel>
            <div style={{ display: 'grid', gap: 10 }}>
              {error && <Banner tone="bad">{error}</Banner>}
              <Button variant="primary" block loading={saving === 'save'} disabled={saving !== null || !allowed} onClick={() => void save(false)}>{strategy ? 'Save changes' : 'Save as disabled'}</Button>
              <Button block loading={saving === 'enable'} disabled={saving !== null || !allowed || !validation?.valid} onClick={() => void save(true)}>Save and enable</Button>
              <span className="faint" style={{ fontSize: 12 }}>
                {validation?.valid ? 'Enabled strategies can be run in paper or live automation from the Trading page; enabling alone places no orders.' : 'You can save an incomplete strategy as a draft. It can only be enabled once every check passes.'}
                {strategy?.status === 'enabled' ? ' Saving changes that fail validation disables the strategy.' : ''}
              </span>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}
