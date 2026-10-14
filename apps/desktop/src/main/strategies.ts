import { randomUUID } from 'node:crypto'
import { audit, transaction, type Db } from './db.js'
import { UserError } from './errors.js'
import { validateDefinition, type StrategyDefinition, type ValidationContext, type ValidationResult } from '../shared/strategyRules.js'
import type { BacktestMetrics, BacktestSummary, Strategy, StrategyVersion, Timeframe } from '../shared/ipc.js'

interface Row {
  id: string
  name: string
  symbol: string
  timeframe: Timeframe | null
  definition: string
  status: 'enabled' | 'disabled'
  source: Strategy['source']
  ai_provider: string | null
  enabled_at: string | null
  created_at: string
  updated_at: string
  prompt: string | null
  version: number
}

export interface SaveMeta {
  source?: 'manual' | 'ai'
  aiProvider?: string
  /** Original plain-language prompt; undefined keeps the stored one. */
  prompt?: string
  /** Plain-language change request that produced this edit. */
  changeRequest?: string
}

/** Minimum shape needed to store a draft; full validation is only required to enable. */
function assertStorable(d: StrategyDefinition): void {
  const fields: Record<string, string> = {}
  if (!d || d.version !== 2 || typeof d !== 'object') throw new UserError('validation_failed', 'Unsupported strategy format.')
  if (!d.name?.trim() || d.name.trim().length > 80) fields.name = 'Name is required (up to 80 characters)'
  if (!/^[A-Z0-9_]{2,32}$/.test(d.symbol ?? '')) fields.symbol = 'Choose an instrument'
  if (!Array.isArray(d.indicators) || !d.entry || !d.exit || !d.risk) throw new UserError('validation_failed', 'The strategy definition is incomplete.')
  if (JSON.stringify(d).length > 64_000) throw new UserError('validation_failed', 'The strategy definition is too large.')
  if (Object.keys(fields).length) throw new UserError('validation_failed', 'Please correct the highlighted fields.', fields)
}

export class StrategyStore {
  constructor(
    private readonly db: Db,
    /** Supplies the instrument list for validation (null when it cannot be loaded). */
    private readonly validationContext: () => Promise<ValidationContext>
  ) {}

  private lastBacktest(id: string): BacktestSummary | null {
    const r = this.db.prepare('SELECT id, metrics, range_start, range_end, created_at FROM backtest_runs WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(id) as
      | { id: string; metrics: string; range_start: number; range_end: number; created_at: string }
      | undefined
    return r ? { runId: r.id, createdAt: r.created_at, metrics: JSON.parse(r.metrics) as BacktestMetrics, rangeStart: r.range_start, rangeEnd: r.range_end } : null
  }

  private toStrategy(r: Row, ctx: ValidationContext): Strategy {
    const definition = JSON.parse(r.definition) as StrategyDefinition
    return {
      id: r.id,
      name: r.name,
      symbol: r.symbol,
      timeframe: r.timeframe,
      definition,
      status: r.status,
      source: r.source,
      aiProvider: r.ai_provider,
      enabledAt: r.enabled_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      validation: validateDefinition(definition, ctx),
      lastBacktest: this.lastBacktest(r.id),
      prompt: r.prompt,
      version: r.version
    }
  }

  private row(id: string): Row {
    const r = this.db.prepare('SELECT * FROM strategies WHERE id = ?').get(id) as Row | undefined
    if (!r) throw new UserError('not_found', 'Strategy not found.')
    return r
  }

  async get(id: string): Promise<Strategy> {
    return this.toStrategy(this.row(id), await this.validationContext())
  }

  async list(): Promise<Strategy[]> {
    const ctx = await this.validationContext()
    return (this.db.prepare('SELECT * FROM strategies ORDER BY updated_at DESC').all() as unknown as Row[]).map((r) => this.toStrategy(r, ctx))
  }

  async validate(d: StrategyDefinition): Promise<ValidationResult> {
    return validateDefinition(d, await this.validationContext())
  }

  private activeSession(id: string): { mode: string } | undefined {
    return this.db.prepare(`SELECT mode FROM automation_sessions WHERE strategy_id = ? AND status != 'stopped'`).get(id) as { mode: string } | undefined
  }

  /** Disabling or deleting a strategy under automation is refused: stop the automation first. */
  private assertNotAutomated(id: string, action: string): void {
    const active = this.activeSession(id)
    if (active) throw new UserError('automation_active', `Stop the ${active.mode} automation for this strategy before you ${action} it.`)
  }

  versions(id: string): StrategyVersion[] {
    this.row(id)
    const rows = this.db.prepare('SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version DESC').all(id) as Record<string, unknown>[]
    return rows.map((v) => ({
      version: Number(v.version),
      name: String(v.name),
      definition: JSON.parse(String(v.definition)) as StrategyDefinition,
      prompt: (v.prompt as string | null) ?? null,
      changeRequest: (v.change_request as string | null) ?? null,
      source: v.source as StrategyVersion['source'],
      aiProvider: (v.ai_provider as string | null) ?? null,
      createdAt: String(v.created_at)
    }))
  }

  private insertVersion(id: string, version: number, d: StrategyDefinition, prompt: string | null, meta: SaveMeta, at: string) {
    this.db.prepare('INSERT INTO strategy_versions (strategy_id, version, name, definition, prompt, change_request, source, ai_provider, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, version, d.name, JSON.stringify(d), prompt, meta.changeRequest?.slice(0, 4000) ?? null, meta.source ?? 'manual', meta.aiProvider ?? null, at)
  }

  /**
   * Saves a draft or a new version. Every change to the rules creates a new immutable version;
   * running automations keep the version they started with until the client applies the new one.
   * Editing an enabled strategy re-validates it; if the edit makes it invalid, it is disabled
   * (or, while an automation runs it, the edit is refused).
   */
  async save(id: string | undefined, input: StrategyDefinition, meta: SaveMeta = {}): Promise<Strategy> {
    assertStorable(input)
    const d: StrategyDefinition = { ...input, name: input.name.trim(), description: (input.description ?? '').trim() }
    const prompt = meta.prompt === undefined ? undefined : meta.prompt.trim().slice(0, 8000) || null
    const now = new Date().toISOString()
    const json = JSON.stringify(d)
    try {
      if (id) {
        const existing = this.row(id)
        const newPrompt = prompt === undefined ? existing.prompt : prompt
        if (json === existing.definition && newPrompt === existing.prompt) return this.get(id)
        const valid = (await this.validate(d)).valid
        const active = this.activeSession(id)
        if (active && !valid) throw new UserError('automation_active', `A ${active.mode} automation is running this strategy, so only a valid version can be saved. Fix the problems or stop the automation first.`)
        let status = existing.status
        let enabledAt = existing.enabled_at
        if (status === 'enabled' && !valid) {
          status = 'disabled'
          enabledAt = null
        }
        const version = existing.version + 1
        transaction(this.db, () => {
          this.db.prepare('UPDATE strategies SET name = ?, symbol = ?, timeframe = ?, definition = ?, status = ?, enabled_at = ?, prompt = ?, version = ?, updated_at = ? WHERE id = ?')
            .run(d.name, d.symbol, d.timeframe, json, status, enabledAt, newPrompt, version, now, id)
          this.insertVersion(id, version, d, newPrompt, meta, now)
        })
        audit(this.db, 'strategy.updated', { id, version, disabledByEdit: existing.status !== status, source: meta.source ?? 'manual', runningAutomation: Boolean(active) })
        return this.get(id)
      }
      const newId = randomUUID()
      transaction(this.db, () => {
        this.db.prepare('INSERT INTO strategies (id, name, symbol, timeframe, definition, status, source, ai_provider, prompt, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
          .run(newId, d.name, d.symbol, d.timeframe, json, 'disabled', meta.source ?? 'manual', meta.aiProvider ?? null, prompt ?? null, now, now)
        this.insertVersion(newId, 1, d, prompt ?? null, meta, now)
      })
      audit(this.db, 'strategy.created', { id: newId, source: meta.source ?? 'manual' })
      return this.get(newId)
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
        throw new UserError('validation_failed', 'A strategy with this name already exists.', { name: 'Name already used' })
      }
      throw err
    }
  }

  /** Enabling requires a fully valid strategy; the errors are returned so the client can fix them. */
  async setEnabled(id: string, enabled: boolean): Promise<Strategy> {
    const s = await this.get(id)
    if (!enabled) this.assertNotAutomated(id, 'disable')
    if (enabled) {
      if (!s.validation.valid) {
        const fields = Object.fromEntries(s.validation.errors.map((e) => [e.path || 'strategy', e.message]))
        throw new UserError('strategy_invalid', `Fix ${s.validation.errors.length} problem${s.validation.errors.length === 1 ? '' : 's'} before enabling: ${s.validation.errors[0]!.message}`, fields)
      }
      this.db.prepare(`UPDATE strategies SET status = 'enabled', enabled_at = ?, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), new Date().toISOString(), id)
    } else {
      this.db.prepare(`UPDATE strategies SET status = 'disabled', enabled_at = NULL, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id)
    }
    audit(this.db, enabled ? 'strategy.enabled' : 'strategy.disabled', { id })
    return this.get(id)
  }

  delete(id: string): void {
    const r = this.row(id)
    this.assertNotAutomated(id, 'delete')
    this.db.prepare('DELETE FROM strategies WHERE id = ?').run(id)
    audit(this.db, 'strategy.deleted', { id, name: r.name })
  }

  async duplicate(id: string): Promise<Strategy> {
    const r = this.row(id)
    const d = JSON.parse(r.definition) as StrategyDefinition
    let name = `${d.name} (copy)`.slice(0, 80)
    for (let i = 2; this.db.prepare('SELECT 1 FROM strategies WHERE lower(name) = lower(?)').get(name); i++) name = `${d.name} (copy ${i})`.slice(0, 80)
    return this.save(undefined, { ...d, name }, { source: r.source === 'ai' ? 'ai' : 'manual', aiProvider: r.ai_provider ?? undefined, prompt: r.prompt ?? undefined })
  }

  recordBacktest(strategyId: string, symbol: string, timeframe: Timeframe, rangeStart: number, rangeEnd: number, metrics: BacktestMetrics, version?: number): string {
    const id = randomUUID()
    this.db.prepare('INSERT INTO backtest_runs (id, strategy_id, symbol, timeframe, range_start, range_end, metrics, created_at, strategy_version) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, strategyId, symbol, timeframe, rangeStart, rangeEnd, JSON.stringify(metrics), new Date().toISOString(), version ?? null)
    return id
  }
}
