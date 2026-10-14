import { randomUUID } from 'node:crypto'
import { audit, type Db } from './db.js'
import { UserError } from './errors.js'
import type { BacktestMetrics, BacktestSummary, Strategy, StrategyInput, StrategyRisk, StrategyType, Timeframe } from '../shared/ipc.js'
import { RISK_LIMITS, STRATEGY_PARAMS, TIMEFRAMES } from '../shared/strategySpec.js'

export { RISK_LIMITS, STRATEGY_PARAMS }

interface Row {
  id: string
  name: string
  symbol: string
  timeframe: Timeframe
  type: StrategyType
  params: string
  risk: string
  allow_short: number
  status: Strategy['status']
  notes: string
  created_at: string
  updated_at: string
}

export function validateStrategy(input: StrategyInput): { value: StrategyInput; fields: Record<string, string> } {
  const fields: Record<string, string> = {}
  const name = (input.name ?? '').trim()
  if (!name || name.length > 80) fields.name = 'Name is required (max 80 characters)'
  const symbol = (input.symbol ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9_]{2,32}$/.test(symbol)) fields.symbol = 'Choose a market symbol'
  if (!TIMEFRAMES.includes(input.timeframe)) fields.timeframe = 'Choose a timeframe'
  const spec = STRATEGY_PARAMS[input.type]
  const params: Record<string, number> = {}
  if (!spec) fields.type = 'Choose a strategy type'
  else {
    for (const [k, [lo, hi, def]] of Object.entries(spec)) {
      const v = input.params?.[k] ?? def
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) fields[`params.${k}`] = `Between ${lo} and ${hi}`
      else params[k] = v
    }
    if ((input.type === 'sma_cross' || input.type === 'ema_cross') && params.fast !== undefined && params.slow !== undefined && params.fast >= params.slow) {
      fields['params.fast'] = 'Fast period must be shorter than slow'
    }
    if (input.type === 'rsi_reversion' && params.oversold !== undefined && params.overbought !== undefined && params.oversold >= params.overbought) {
      fields['params.oversold'] = 'Oversold must be below overbought'
    }
  }
  const risk = {} as StrategyRisk
  for (const [k, [lo, hi, def]] of Object.entries(RISK_LIMITS) as [keyof StrategyRisk, [number, number, number]][]) {
    const v = input.risk?.[k] ?? def
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) fields[`risk.${k}`] = `Between ${lo} and ${hi}`
    else risk[k] = v
  }
  const notes = (input.notes ?? '').slice(0, 2000)
  return { value: { ...input, name, symbol, params, risk, notes, allowShort: Boolean(input.allowShort) }, fields }
}

export class StrategyStore {
  constructor(private readonly db: Db) {}

  private lastBacktest(id: string): BacktestSummary | null {
    const r = this.db.prepare('SELECT id, metrics, range_start, range_end, created_at FROM backtest_runs WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(id) as
      | { id: string; metrics: string; range_start: number; range_end: number; created_at: string }
      | undefined
    return r ? { runId: r.id, createdAt: r.created_at, metrics: JSON.parse(r.metrics) as BacktestMetrics, rangeStart: r.range_start, rangeEnd: r.range_end } : null
  }

  private toStrategy(r: Row): Strategy {
    return {
      id: r.id,
      name: r.name,
      symbol: r.symbol,
      timeframe: r.timeframe,
      type: r.type,
      params: JSON.parse(r.params),
      risk: JSON.parse(r.risk),
      allowShort: Boolean(r.allow_short),
      status: r.status,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastBacktest: this.lastBacktest(r.id)
    }
  }

  get(id: string): Strategy {
    const r = this.db.prepare('SELECT * FROM strategies WHERE id = ?').get(id) as Row | undefined
    if (!r) throw new UserError('not_found', 'Strategy not found.')
    return this.toStrategy(r)
  }

  list(includeArchived = false): Strategy[] {
    const rows = this.db.prepare(`SELECT * FROM strategies ${includeArchived ? '' : "WHERE status != 'archived'"} ORDER BY updated_at DESC`).all() as unknown as Row[]
    return rows.map((r) => this.toStrategy(r))
  }

  save(id: string | undefined, input: StrategyInput): Strategy {
    const { value, fields } = validateStrategy(input)
    if (Object.keys(fields).length) throw new UserError('validation_failed', 'Please correct the highlighted fields.', fields)
    const now = new Date().toISOString()
    const status = value.status === 'paper' ? 'paper' : 'draft'
    try {
      if (id) {
        const existing = this.get(id)
        if (existing.status === 'archived') throw new UserError('archived', 'Restore this strategy before editing it.')
        this.db.prepare('UPDATE strategies SET name=?, symbol=?, timeframe=?, type=?, params=?, risk=?, allow_short=?, status=?, notes=?, updated_at=? WHERE id=?')
          .run(value.name, value.symbol, value.timeframe, value.type, JSON.stringify(value.params), JSON.stringify(value.risk), value.allowShort ? 1 : 0, status, value.notes, now, id)
        audit(this.db, 'strategy.updated', { id })
        return this.get(id)
      }
      const newId = randomUUID()
      this.db.prepare('INSERT INTO strategies (id, name, symbol, timeframe, type, params, risk, allow_short, status, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(newId, value.name, value.symbol, value.timeframe, value.type, JSON.stringify(value.params), JSON.stringify(value.risk), value.allowShort ? 1 : 0, status, value.notes, now, now)
      audit(this.db, 'strategy.created', { id: newId })
      return this.get(newId)
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
        throw new UserError('validation_failed', 'A strategy with this name already exists.', { name: 'Name already used' })
      }
      throw err
    }
  }

  setStatus(id: string, status: 'archived' | 'draft'): Strategy {
    this.get(id)
    try {
      this.db.prepare('UPDATE strategies SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id)
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) throw new UserError('name_conflict', 'An active strategy already uses this name. Rename it first.')
      throw err
    }
    audit(this.db, status === 'archived' ? 'strategy.archived' : 'strategy.restored', { id })
    return this.get(id)
  }

  delete(id: string): void {
    const s = this.get(id)
    if (s.status !== 'archived') throw new UserError('not_archived', 'Archive the strategy before deleting it permanently.')
    this.db.prepare('DELETE FROM strategies WHERE id = ?').run(id)
    audit(this.db, 'strategy.deleted', { id, name: s.name })
  }

  duplicate(id: string): Strategy {
    const s = this.get(id)
    let name = `${s.name} (copy)`.slice(0, 80)
    for (let i = 2; this.db.prepare(`SELECT 1 FROM strategies WHERE lower(name) = lower(?) AND status != 'archived'`).get(name); i++) name = `${s.name} (copy ${i})`.slice(0, 80)
    return this.save(undefined, { name, symbol: s.symbol, timeframe: s.timeframe, type: s.type, params: s.params, risk: s.risk, allowShort: s.allowShort, notes: s.notes })
  }

  recordBacktest(strategyId: string, symbol: string, timeframe: Timeframe, rangeStart: number, rangeEnd: number, metrics: BacktestMetrics): string {
    const id = randomUUID()
    this.db.prepare('INSERT INTO backtest_runs (id, strategy_id, symbol, timeframe, range_start, range_end, metrics, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, strategyId, symbol, timeframe, rangeStart, rangeEnd, JSON.stringify(metrics), new Date().toISOString())
    return id
  }
}
