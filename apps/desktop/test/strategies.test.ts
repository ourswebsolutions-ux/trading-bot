import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { MIGRATIONS, migrate, openDatabase } from '../src/main/db.js'
import { StrategyStore } from '../src/main/strategies.js'
import { convertLegacy, explainDefinition, validateDefinition, type StrategyDefinition } from '../src/shared/strategyRules.js'
import { memoryDb, rsiStrategy } from './helpers.js'

const ctx = { instruments: ['BTCUSD', 'ETHUSD'] }

const errorPaths = (d: StrategyDefinition, c = ctx) => validateDefinition(d, c).errors.map((e) => e.path)

describe('strategy validation', () => {
  it('accepts a complete strategy', () => {
    const r = validateDefinition(rsiStrategy(), ctx)
    assert.deepEqual(r.errors, [])
    assert.equal(r.valid, true)
  })

  it('reports every missing required element instead of filling it in', () => {
    const d = rsiStrategy({ timeframe: null, direction: null, risk: { stopLoss: null, takeProfit: null, sizing: null, maxDailyLossPct: null, maxTradesPerDay: null, feeBps: 5 } })
    const paths = errorPaths(d)
    for (const p of ['timeframe', 'direction', 'risk.stopLoss', 'risk.sizing', 'risk.maxDailyLossPct', 'risk.maxTradesPerDay']) assert.ok(paths.includes(p), p)
  })

  it('checks instruments, timeframes and indicators are supported', () => {
    assert.ok(errorPaths(rsiStrategy({ symbol: 'EURUSD' })).includes('symbol'))
    assert.match(validateDefinition(rsiStrategy(), { instruments: null }).errors[0]!.message, /cannot be verified/)
    assert.ok(errorPaths(rsiStrategy({ timeframe: '2h' as never })).includes('timeframe'))
    assert.ok(errorPaths(rsiStrategy({ indicators: [{ id: 'rsi_14', kind: 'macd' as never, period: 14 }] })).includes('indicators.0.kind'))
    assert.ok(errorPaths(rsiStrategy({ indicators: [{ id: 'rsi_14', kind: 'rsi', period: 500 }] })).includes('indicators.0.period'))
  })

  it('rejects references to undefined indicators and impossible comparisons', () => {
    const undefinedRef = rsiStrategy()
    undefinedRef.entry.long!.conditions[0]!.left = { type: 'indicator', id: 'ema_50' }
    assert.ok(errorPaths(undefinedRef).includes('entry.long.conditions.0.left'))
    const rsiOutOfRange = rsiStrategy()
    rsiOutOfRange.entry.long!.conditions[0]!.right = { type: 'value', value: 150 }
    assert.match(validateDefinition(rsiOutOfRange, ctx).errors[0]!.message, /0 to 100/)
    const constants = rsiStrategy()
    constants.entry.long!.conditions[0] = { left: { type: 'value', value: 1 }, op: '<', right: { type: 'value', value: 2 } }
    assert.ok(errorPaths(constants).includes('entry.long.conditions.0'))
  })

  it('rejects contradictory rules', () => {
    const both = rsiStrategy()
    both.entry.long!.conditions.push({ left: { type: 'indicator', id: 'rsi_14' }, op: '>', right: { type: 'value', value: 70 } })
    assert.match(validateDefinition(both, ctx).errors.map((e) => e.message).join(' '), /contradict/)
    const sameExit = rsiStrategy({ exit: { long: { match: 'all', conditions: [{ left: { type: 'indicator', id: 'rsi_14' }, op: '<', right: { type: 'value', value: 30 } }] }, short: null } })
    assert.ok(errorPaths(sameExit).includes('exit.long'))
    const wrongSide = rsiStrategy({ entry: { long: rsiStrategy().entry.long, short: rsiStrategy().exit.long } })
    assert.ok(errorPaths(wrongSide).includes('entry.short'))
  })

  it('validates stop-loss, take-profit, sizing and daily limits', () => {
    const r = rsiStrategy()
    assert.ok(errorPaths({ ...r, risk: { ...r.risk, stopLoss: { type: 'percent', value: 0 } } }).includes('risk.stopLoss.value'))
    assert.ok(errorPaths({ ...r, risk: { ...r.risk, takeProfit: { type: 'risk_multiple', value: 50 } } }).includes('risk.takeProfit.value'))
    assert.ok(errorPaths({ ...r, risk: { ...r.risk, sizing: { type: 'percent_equity', value: 150 } } }).includes('risk.sizing.value'))
    assert.ok(errorPaths({ ...r, risk: { ...r.risk, maxTradesPerDay: 2.5 } }).includes('risk.maxTradesPerDay'))
    assert.match(validateDefinition({ ...r, risk: { ...r.risk, sizing: { type: 'risk_percent', value: 5 }, maxDailyLossPct: 2 } }, ctx).errors[0]!.message, /exceed the maximum daily loss/)
  })

  it('explains entry, exit and risk rules in plain language', () => {
    const e = explainDefinition(rsiStrategy())
    assert.match(e.entry[0]!, /Buy \(go long\) BTCUSD when the 14-candle RSI \(0–100\) is below 30/)
    assert.match(e.entry[1]!, /next candle's open/)
    assert.match(e.exit.join(' '), /Stop-loss: 2% from the entry price/)
    assert.match(e.exit.join(' '), /Take-profit: 2 × the stop-loss distance/)
    assert.match(e.risk.join(' '), /stop-out loses 1% of equity/)
    assert.match(e.risk.join(' '), /maximum realized loss 3% of equity; at most 4 trades per UTC day/)
  })

  it('converts Phase 1–2 templates faithfully and leaves new limits unset', () => {
    const d = convertLegacy({ name: 'Old', symbol: 'BTCUSD', timeframe: '4h', type: 'breakout', params: { lookback: 20 }, risk: { positionPct: 10, stopLossPct: 2, takeProfitPct: 0, feeBps: 5 }, allowShort: true, notes: 'n' })
    assert.equal(d.direction, 'both')
    assert.deepEqual(d.entry.long!.conditions[0], { left: { type: 'price', field: 'close' }, op: '>', right: { type: 'indicator', id: 'highest_high_20' } })
    assert.equal(d.risk.takeProfit, null)
    assert.deepEqual(errorPaths(d).sort(), ['risk.maxDailyLossPct', 'risk.maxTradesPerDay'])
  })
})

describe('strategy storage', () => {
  it('saves drafts, blocks enabling invalid strategies, and persists across restarts', async (t) => {
    const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'tp-strat-'))
    t.after(() => (import('node:fs').then((fs) => fs.rmSync(dir, { recursive: true, force: true }))))
    const file = `${dir}/db.sqlite`
    const store = new StrategyStore(openDatabase(file), async () => ctx)
    const incomplete = rsiStrategy({ risk: { ...rsiStrategy().risk, maxDailyLossPct: null } })
    const s = await store.save(undefined, incomplete)
    assert.equal(s.status, 'disabled')
    assert.equal(s.validation.valid, false)
    await assert.rejects(store.setEnabled(s.id, true), /before enabling/)
    await store.save(s.id, rsiStrategy())
    const enabled = await store.setEnabled(s.id, true)
    assert.equal(enabled.status, 'enabled')
    assert.ok(enabled.enabledAt)

    // editing an enabled strategy into an invalid state disables it instead of keeping broken rules live
    const broken = await store.save(s.id, rsiStrategy({ risk: { ...rsiStrategy().risk, stopLoss: null } }))
    assert.equal(broken.status, 'disabled')
    await store.save(s.id, rsiStrategy())
    await store.setEnabled(s.id, true)
    const copy = await store.duplicate(s.id)
    assert.equal(copy.name, 'RSI dip buyer (copy)')
    assert.equal(copy.status, 'disabled', 'copies start disabled')
    await assert.rejects(store.save(undefined, rsiStrategy()), /already exists/)

    const restarted = new StrategyStore(openDatabase(file), async () => ctx)
    const all = await restarted.list()
    assert.equal(all.length, 2)
    const again = all.find((x) => x.id === s.id)!
    assert.equal(again.status, 'enabled')
    assert.deepEqual(again.definition, rsiStrategy())
    restarted.delete(copy.id)
    assert.equal((await restarted.list()).length, 1)
  })

  it('migrates Phase 1–2 strategies and keeps their backtest history', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db, MIGRATIONS.slice(0, 2))
    db.prepare(`INSERT INTO strategies (id, name, symbol, timeframe, type, params, risk, allow_short, status, notes, created_at, updated_at) VALUES ('s1','Trend','BTCUSD','1h','ema_cross','{"fast":12,"slow":26}','{"positionPct":10,"stopLossPct":2,"takeProfitPct":4,"feeBps":5}',0,'paper','',datetime('now'),datetime('now'))`).run()
    db.prepare(`INSERT INTO strategies (id, name, symbol, timeframe, type, params, risk, allow_short, status, notes, created_at, updated_at) VALUES ('s2','Trend','BTCUSD','1h','rsi_reversion','{"period":14,"oversold":30,"overbought":70}','{"positionPct":10,"stopLossPct":2,"takeProfitPct":4,"feeBps":5}',0,'archived','',datetime('now'),datetime('now'))`).run()
    db.prepare(`INSERT INTO backtest_runs VALUES ('b1','s1','BTCUSD','1h',1,2,'{}',datetime('now'))`).run()
    assert.deepEqual(migrate(db), [3, 4, 5])
    const rows = db.prepare('SELECT id, name, status, source, definition FROM strategies ORDER BY id').all() as { id: string; name: string; status: string; source: string; definition: string }[]
    assert.deepEqual(rows.map((r) => [r.id, r.name, r.status, r.source]), [['s1', 'Trend', 'disabled', 'converted'], ['s2', 'Trend (2)', 'disabled', 'converted']])
    assert.equal(JSON.parse(rows[0]!.definition).indicators[0].kind, 'ema')
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM backtest_runs').get() as { n: number }).n, 1, 'history survived the table rebuild')
  })

  it('repairs databases created by the earlier pre-release schema', () => {
    const cur = MIGRATIONS[0]!.sql
    const legacySql = cur
      .replace(/CREATE TABLE secrets \([\s\S]*?\);/, 'CREATE TABLE secrets (\n  name TEXT PRIMARY KEY,\n  ciphertext BLOB NOT NULL,\n  hint TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);')
      .replace('-- Values are encrypted with Electron safeStorage (OS keychain-backed key). The only value allowed\n-- to fall back to unencrypted storage (encrypted = 0) is the device token, when no keychain exists.', '-- Values are encrypted with Electron safeStorage (OS keychain-backed key). Never plaintext.')
    const db = new DatabaseSync(':memory:')
    migrate(db, [{ version: 1, name: 'initial_local_schema', sql: legacySql }])
    db.prepare(`INSERT INTO secrets VALUES ('openai.apiKey', x'00', '••••abcd', 'now')`).run()
    assert.doesNotThrow(() => migrate(db))
    assert.equal((db.prepare('SELECT encrypted FROM secrets').get() as { encrypted: number }).encrypted, 1)
    const unknown = new DatabaseSync(':memory:')
    migrate(unknown, [{ version: 1, name: 'x', sql: 'CREATE TABLE z (a)' }])
    assert.throws(() => migrate(unknown), /modified after being applied/)
  })
})

void memoryDb

describe('database backups before schema changes', () => {
  it('snapshots an existing database before applying new migrations and keeps the newest three', async () => {
    const { mkdtempSync, readdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const { backupBeforeMigrating } = await import('../src/main/db.js')
    const dir = mkdtempSync(path.join(tmpdir(), 'tp-backup-'))
    const file = path.join(dir, 'tradepilot.sqlite')
    const old = new DatabaseSync(file)
    migrate(old, MIGRATIONS.filter((m) => m.version <= 3))
    old.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('marker', '"kept"', 'now')`).run()
    old.close()
    const db = openDatabase(file) // applies 4 and 5, after a backup
    db.close()
    const backups = readdirSync(dir).filter((f) => f.endsWith('.bak'))
    assert.equal(backups.length, 1)
    assert.match(backups[0]!, /\.pre-v4-/)
    const restored = new DatabaseSync(path.join(dir, backups[0]!))
    assert.equal((restored.prepare(`SELECT value FROM app_settings WHERE key = 'marker'`).get() as { value: string }).value, '"kept"')
    assert.equal((restored.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number }).v, 3)
    restored.close()
    // up to date: no new backup; fresh database: none either
    openDatabase(file).close()
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.bak')).length, 1)
    const fresh = path.join(dir, 'fresh.sqlite')
    openDatabase(fresh).close()
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('fresh') && f.endsWith('.bak')).length, 0)
    // retention
    const again = new DatabaseSync(file)
    for (let i = 0; i < 5; i++) assert.ok(backupBeforeMigrating(again, file, [...MIGRATIONS, { version: 99, name: 'future', sql: 'SELECT 1' }]))
    again.close()
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('tradepilot.sqlite.pre-v') && f.endsWith('.bak')).length, 3)
  })
})
