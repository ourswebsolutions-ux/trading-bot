import type { Strategy } from '@shared/ipc'
import {
  COMPARATOR_TEXT,
  INDICATORS,
  describeDailyLoss,
  describeSizingFor,
  describeStop,
  describeTarget,
  explainDefinition,
  type Operand,
  type RuleGroup,
  type StrategyDefinition,
  type ValidationResult
} from '@shared/strategyRules'
import { Icon } from '../../components/icons'
import { Badge } from '../../components/ui'

export function operandLabel(o: Operand, d: StrategyDefinition): string {
  if (o.type === 'price') return `${o.field[0]!.toUpperCase()}${o.field.slice(1)} price`
  if (o.type === 'value') return Number.isFinite(o.value) ? String(o.value) : '?'
  const ind = d.indicators.find((i) => i.id === o.id)
  return ind ? `${INDICATORS[ind.kind].label} (${ind.period}${ind.stdDev ? `, ${ind.stdDev}σ` : ''})` : `${o.id || '?'} (undefined)`
}

export function GroupView({ g, d, empty }: { g: RuleGroup | null; d: StrategyDefinition; empty: string }) {
  if (!g || g.conditions.length === 0) return <div className="faint">{empty}</div>
  return (
    <div className="rule-group">
      {g.conditions.length > 1 && <div className="rule-match">{g.match === 'all' ? 'All of these are true' : 'Any of these is true'}</div>}
      {g.conditions.map((c, i) => (
        <div key={i} className="rule-line">
          <span className="rule-operand">{operandLabel(c.left, d)}</span>
          <span className="rule-op">{COMPARATOR_TEXT[c.op] ?? c.op}</span>
          <span className="rule-operand">{operandLabel(c.right, d)}</span>
        </div>
      ))}
    </div>
  )
}

export function RulesView({ d }: { d: StrategyDefinition }) {
  const long = d.direction === 'long' || d.direction === 'both'
  const short = d.direction === 'short' || d.direction === 'both'
  return (
    <div className="rules-view">
      <dl className="kv" style={{ gridTemplateColumns: '140px 1fr' }}>
        <dt>Instrument</dt><dd className="mono">{d.symbol || <span className="down">not set</span>}</dd>
        <dt>Timeframe</dt><dd>{d.timeframe ?? <span className="down">not set</span>}</dd>
        <dt>Direction</dt><dd>{d.direction ? { long: 'Buy (long) only', short: 'Sell short only', both: 'Long and short' }[d.direction] : <span className="down">not set</span>}</dd>
        <dt>Indicators</dt><dd>{d.indicators.length ? d.indicators.map((i) => `${INDICATORS[i.kind]?.label ?? i.kind} ${i.period}${i.stdDev ? `/${i.stdDev}σ` : ''}`).join(' · ') : 'none'}</dd>
      </dl>
      {(long || !d.direction) && <div className="rules-block"><div className="panel-title">Buy (long entry)</div><GroupView g={d.entry.long} d={d} empty="No buy rules." /></div>}
      {short && <div className="rules-block"><div className="panel-title">Sell short (short entry)</div><GroupView g={d.entry.short} d={d} empty="No sell-short rules." /></div>}
      {long && <div className="rules-block"><div className="panel-title">Close long</div><GroupView g={d.exit.long} d={d} empty="No rule-based exit; stop-loss / take-profit only." /></div>}
      {short && <div className="rules-block"><div className="panel-title">Close short</div><GroupView g={d.exit.short} d={d} empty="No rule-based exit; stop-loss / take-profit only." /></div>}
      <div className="rules-block">
        <div className="panel-title">Risk</div>
        <dl className="kv" style={{ gridTemplateColumns: '140px 1fr' }}>
          <dt>Stop-loss</dt><dd>{d.risk.stopLoss ? describeStop(d.risk.stopLoss) : <span className="down">not set</span>}</dd>
          <dt>Take-profit</dt><dd>{describeTarget(d.risk.takeProfit)}</dd>
          <dt>Position size</dt><dd>{d.risk.sizing ? describeSizingFor(d.risk) : <span className="down">not set</span>}</dd>
          <dt>Allocated capital</dt><dd>{typeof d.risk.allocatedCapitalUsd === 'number' ? `$${d.risk.allocatedCapitalUsd.toLocaleString('en-US')}` : 'not set (whole account equity)'}</dd>
          <dt>Max daily loss</dt><dd>{describeDailyLoss(d.risk) !== 'not set' ? describeDailyLoss(d.risk) : <span className="down">not set</span>}</dd>
          <dt>Max trades / day</dt><dd>{d.risk.maxTradesPerDay ?? <span className="down">not set</span>}</dd>
          <dt>Fee assumption</dt><dd>{d.risk.feeBps} bps per side (backtests)</dd>
        </dl>
      </div>
    </div>
  )
}

export function ValidationList({ v, compact }: { v: ValidationResult | null; compact?: boolean }) {
  if (!v) return <div className="faint">Checking…</div>
  return (
    <div className="validation-list">
      {v.valid ? (
        <div className="v-ok"><Icon name="check" size={14} /> All checks passed{v.warnings.length ? ` · ${v.warnings.length} warning${v.warnings.length === 1 ? '' : 's'}` : ''}</div>
      ) : (
        <div className="v-head down"><Icon name="alert" size={14} /> {v.errors.length} problem{v.errors.length === 1 ? '' : 's'} must be fixed before this strategy can be enabled</div>
      )}
      {v.errors.slice(0, compact ? 4 : 50).map((e, i) => <div key={`e${i}`} className="v-item bad">{e.message}</div>)}
      {compact && v.errors.length > 4 && <div className="faint">and {v.errors.length - 4} more…</div>}
      {v.warnings.map((w, i) => <div key={`w${i}`} className="v-item warn">{w.message}</div>)}
    </div>
  )
}

export function ExplanationView({ d }: { d: StrategyDefinition }) {
  const e = explainDefinition(d)
  return (
    <div className="explanation">
      <div><div className="panel-title">Entry</div><ul>{e.entry.map((t, i) => <li key={i}>{t}</li>)}</ul></div>
      <div><div className="panel-title">Exit</div><ul>{e.exit.map((t, i) => <li key={i}>{t}</li>)}</ul></div>
      <div><div className="panel-title">Risk</div><ul>{e.risk.map((t, i) => <li key={i}>{t}</li>)}</ul></div>
    </div>
  )
}

export function riskSummary(d: StrategyDefinition): string {
  const r = d.risk
  const stop = r.stopLoss ? (r.stopLoss.type === 'percent' ? `SL ${r.stopLoss.value}%` : r.stopLoss.type === 'points' ? `SL ${r.stopLoss.value} pts` : `SL ${r.stopLoss.value}×ATR`) : 'no SL'
  const tp = r.takeProfit ? (r.takeProfit.type === 'percent' ? `TP ${r.takeProfit.value}%` : r.takeProfit.type === 'points' ? `TP ${r.takeProfit.value} pts` : `TP ${r.takeProfit.value}R`) : 'no TP'
  const size = r.sizing ? (r.sizing.type === 'percent_equity' ? `${r.sizing.value}% eq` : r.sizing.type === 'risk_percent' ? `risk ${r.sizing.value}%` : `${r.sizing.value} qty`) : 'no size'
  return `${stop} · ${tp} · ${size}`
}

export function limitsSummary(d: StrategyDefinition): string {
  const r = d.risk
  const loss = [r.maxDailyLossPct != null ? `${r.maxDailyLossPct}%` : null, r.maxDailyLossUsd != null ? `$${r.maxDailyLossUsd}` : null].filter(Boolean).join(' / ') || '?'
  return `max loss ${loss}/day · ${r.maxTradesPerDay ?? '?'} trades/day`
}

export function StatusBadge({ s }: { s: Strategy }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {s.status === 'enabled' ? <Badge tone="ok">Enabled</Badge> : <Badge>Disabled</Badge>}
      {!s.validation.valid && <Badge tone="warn">Needs attention</Badge>}
      {s.source === 'ai' && <Badge tone="info">AI-interpreted</Badge>}
      {s.source === 'converted' && <Badge>Converted</Badge>}
    </span>
  )
}
