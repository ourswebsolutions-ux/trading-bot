import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OpenAiProvider } from '../src/main/ai/openai.js'
import { AiUsageTracker, type AiSettings } from '../src/main/ai/provider.js'
import { crossCheck, interpretTurn, systemPrompt } from '../src/main/ai/strategyInterpreter.js'
import { MIGRATIONS, migrate } from '../src/main/db.js'
import { StrategyStore } from '../src/main/strategies.js'
import { diffDefinitions, explainDefinition, validateDefinition, type StrategyDefinition } from '../src/shared/strategyRules.js'
import { fakeFetch, memoryDb, noSleep, rsiStrategy } from './helpers.js'
import { DatabaseSync } from 'node:sqlite'

const ctx = { instruments: ['BTCUSD', 'ETHUSD'] }
const SYMBOLS = ['BTCUSD', 'ETHUSD']
const settings = (model: string): AiSettings => ({ model, maxOutputTokens: 1024, timeoutSec: 30, dailyRequestLimit: 50, dailyTokenLimit: 1_000_000 })
const operand = (o: Partial<{ type: string; indicatorId: string; priceField: string; value: number }>) => ({ type: 'value', indicatorId: null, priceField: null, value: null, ...o })
const chat = (content: unknown) => [200, { model: 'gpt-x', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 900, completion_tokens: 300 } }] as [number, unknown]
const openai = (content: unknown) => {
  const f = fakeFetch(() => chat(content))
  return { f, provider: new OpenAiProvider('k', f.impl, noSleep) }
}
const errorPaths = (d: StrategyDefinition) => validateDefinition(d, ctx).errors.map((e) => e.path)

const USER_EXAMPLE =
  'Trade BTC when the 15-minute trend is bullish and RSI crosses above 30. Use 2% of my allocated trading capital per trade, set stop-loss at 1.5%, take-profit at 3%, and stop opening new trades after a daily loss of $20.'

/** What a well-behaved model returns for the example prompt: everything explicit is mapped, the vague parts are asked about. */
const exampleTurn = {
  status: 'needs_clarification',
  questions: [
    'How should "the 15-minute trend is bullish" be defined: close above the 50-period EMA, or the 20 EMA above the 50 EMA?',
    'How much capital (USD) is allocated to this strategy?',
    'What is the maximum number of trades per day?'
  ],
  ambiguities: ['"trend is bullish" has no exact definition'],
  unsupported: [],
  summary: 'Buy BTCUSD on 15-minute candles when RSI(14) crosses above 30, 2% of allocated capital per trade, 1.5% stop, 3% target, stop after a $20 daily loss. Trend definition, capital amount and trade limit are open.',
  strategy: {
    name: 'BTC RSI trend entry', description: null, symbol: 'BTCUSD', timeframe: '15m', direction: 'long',
    indicators: [{ id: 'rsi_14', kind: 'rsi', period: 14, stdDev: null }],
    entryLong: { match: 'all', conditions: [{ left: operand({ type: 'indicator', indicatorId: 'rsi_14' }), op: 'crosses_above', right: operand({ type: 'value', value: 30 }) }] },
    entryShort: null, exitLong: null, exitShort: null,
    stopLoss: { type: 'percent', value: 1.5 }, takeProfit: { type: 'percent', value: 3 }, sizing: { type: 'percent_equity', value: 2 },
    allocatedCapitalUsd: null, maxDailyLossPct: null, maxDailyLossUsd: 20, maxTradesPerDay: null
  }
}
/** After the trader answers: trend = close above EMA 50, $1,000 allocated, 3 trades a day. */
const answeredTurn = {
  ...exampleTurn,
  status: 'ready',
  questions: [],
  ambiguities: [],
  strategy: {
    ...exampleTurn.strategy,
    indicators: [...exampleTurn.strategy.indicators, { id: 'ema_50', kind: 'ema', period: 50, stdDev: null }],
    entryLong: {
      match: 'all',
      conditions: [
        ...exampleTurn.strategy.entryLong.conditions,
        { left: operand({ type: 'price', priceField: 'close' }), op: '>', right: operand({ type: 'indicator', indicatorId: 'ema_50' }) }
      ]
    },
    allocatedCapitalUsd: 1000,
    maxTradesPerDay: 3
  }
}

describe('Phase 5: rule model for prompt-defined risk', () => {
  it('accepts a dollar daily loss instead of (or with) a percent one and requires at least one', () => {
    const usd = rsiStrategy({ risk: { ...rsiStrategy().risk, maxDailyLossPct: null, maxDailyLossUsd: 20 } })
    assert.deepEqual(errorPaths(usd), [])
    const neither = rsiStrategy({ risk: { ...rsiStrategy().risk, maxDailyLossPct: null, maxDailyLossUsd: null } })
    assert.deepEqual(errorPaths(neither), ['risk.maxDailyLossPct'])
    assert.ok(errorPaths(rsiStrategy({ risk: { ...rsiStrategy().risk, maxDailyLossUsd: 0 } })).includes('risk.maxDailyLossUsd'))
  })

  it('validates allocated capital and rejects conflicting risk limits', () => {
    const base = rsiStrategy().risk
    assert.ok(errorPaths(rsiStrategy({ risk: { ...base, allocatedCapitalUsd: 5 } })).includes('risk.allocatedCapitalUsd'))
    // a daily loss limit as large as the whole allocation is not a limit
    assert.ok(errorPaths(rsiStrategy({ risk: { ...base, allocatedCapitalUsd: 100, maxDailyLossUsd: 100 } })).includes('risk.maxDailyLossUsd'))
    // risking 5% of $1,000 ($50) per trade cannot fit in a $20 daily loss limit
    const r = validateDefinition(rsiStrategy({ risk: { ...base, sizing: { type: 'risk_percent', value: 5 }, maxDailyLossPct: 10, allocatedCapitalUsd: 1000, maxDailyLossUsd: 20 } }), ctx)
    assert.match(r.errors.map((e) => e.message).join(' '), /One losing trade .* exceed the \$20 daily loss limit/)
    // percent limit conflict (Phase 3 rule) still applies
    assert.match(validateDefinition(rsiStrategy({ risk: { ...base, sizing: { type: 'risk_percent', value: 5 }, maxDailyLossPct: 2 } }), ctx).errors[0]!.message, /exceed the maximum daily loss/)
  })

  it('explains allocated capital and dollar limits in plain language without implying funds are moved', () => {
    const e = explainDefinition(rsiStrategy({ risk: { ...rsiStrategy().risk, sizing: { type: 'percent_equity', value: 2 }, allocatedCapitalUsd: 1000, maxDailyLossPct: null, maxDailyLossUsd: 20 } })).risk.join(' ')
    assert.match(e, /2% of the \$1,000 allocated capital \(or the account equity, if lower\)/)
    assert.match(e, /does not reserve or move funds/)
    assert.match(e, /maximum realized loss \$20/)
  })

  it('lists exactly what changed between two versions', () => {
    const a = rsiStrategy()
    const b = rsiStrategy({ timeframe: '4h', risk: { ...a.risk, stopLoss: { type: 'percent', value: 1 }, maxDailyLossUsd: 50 } })
    const changes = diffDefinitions(a, b)
    assert.deepEqual(changes.map((c) => c.field), ['Timeframe', 'Stop-loss', 'Daily loss limit'])
    assert.equal(changes[1]!.before, '2% from the entry price')
    assert.equal(changes[1]!.after, '1% from the entry price')
    assert.deepEqual(diffDefinitions(a, structuredClone(a)), [])
  })
})

describe('Phase 5: interpreting plain-language prompts', () => {
  it('maps the example prompt, keeps the vague parts as questions and fills nothing in', async () => {
    const { f, provider } = openai(exampleTurn)
    const turn = await interpretTurn([{ role: 'user', content: USER_EXAMPLE }], provider, new AiUsageTracker(memoryDb()), settings('gpt-x'), SYMBOLS)
    assert.equal(turn.status, 'needs_clarification')
    const d = turn.definition
    assert.equal(d.symbol, 'BTCUSD')
    assert.equal(d.timeframe, '15m')
    assert.deepEqual(d.risk.stopLoss, { type: 'percent', value: 1.5 })
    assert.deepEqual(d.risk.takeProfit, { type: 'percent', value: 3 })
    assert.deepEqual(d.risk.sizing, { type: 'percent_equity', value: 2 })
    assert.equal(d.risk.maxDailyLossUsd, 20)
    assert.equal(d.risk.maxDailyLossPct, null)
    assert.equal(d.risk.allocatedCapitalUsd, null, 'the capital amount was not stated, so it is asked, not assumed')
    assert.equal(d.risk.maxTradesPerDay, null)
    assert.ok(turn.missing.some((m) => /maximum number of trades/.test(m)))
    assert.equal(turn.questions.length, 3)
    // the system prompt describes the new fields and the "do not substitute" rule
    const body = JSON.parse(f.calls[0]!.body!) as { messages: { role: string; content: string }[] }
    assert.match(body.messages[0]!.content, /maxDailyLossUsd/)
    assert.match(body.messages[0]!.content, /Never replace something unsupported/)
  })

  it('becomes ready for review once the trader answers, and the rules validate', async () => {
    const { provider } = openai(answeredTurn)
    const messages = [
      { role: 'user' as const, content: USER_EXAMPLE },
      { role: 'assistant' as const, content: JSON.stringify(exampleTurn) },
      { role: 'user' as const, content: 'Bullish trend = close above the 50 EMA. I allocate $1,000. At most 3 trades a day.' }
    ]
    const turn = await interpretTurn(messages, provider, new AiUsageTracker(memoryDb()), settings('gpt-x'), SYMBOLS)
    assert.equal(turn.status, 'ready_for_review')
    assert.equal(turn.validation.valid, true, JSON.stringify(turn.validation.errors))
    assert.equal(turn.definition.risk.allocatedCapitalUsd, 1000)
    assert.match(turn.explanation.entry.join(' '), /15-candle|15m/)
  })

  it('catches a model that silently changes the timeframe the trader asked for', async () => {
    const wrongTf = { ...answeredTurn, strategy: { ...answeredTurn.strategy, timeframe: '1h' } }
    const { provider } = openai(wrongTf)
    const turn = await interpretTurn([{ role: 'user', content: USER_EXAMPLE + ' Trend = close above EMA 50, $1,000 allocated, 3 trades a day.' }], provider, new AiUsageTracker(memoryDb()), settings('gpt-x'), SYMBOLS)
    assert.equal(turn.status, 'needs_clarification', 'not saveable while the rules contradict the prompt')
    assert.ok(turn.missing.some((m) => /You mentioned the 15m timeframe, but the interpreted rules use 1h/.test(m)))
  })

  it('flags unsupported requests found in the trader\'s own words, even when the model does not', () => {
    const c = crossCheck('Buy when MACD crosses up on the 1-hour chart and the 4-hour trend is up, with a trailing stop.', rsiStrategy())
    const text = c.unsupported.join(' | ')
    assert.match(text, /MACD is not an available indicator/)
    assert.match(text, /trailing stops are not supported/)
    assert.match(text, /several timeframes \(1h, 4h\)/)
    assert.deepEqual(crossCheck('Trade BTCUSD on the 1-hour chart when RSI is below 30', rsiStrategy()).unsupported, [])
    assert.match(crossCheck('exit after 2 hours', rsiStrategy()).unsupported.join(' '), /time-based exits are not supported/)
  })

  it('reports a prompt that cannot be implemented as unsupported instead of inventing rules', async () => {
    const turnData = { status: 'unsupported', questions: [], ambiguities: [], unsupported: ['Buying when Elon Musk tweets: news or social media conditions cannot be implemented'], summary: 'Nothing here can be expressed.', strategy: { ...exampleTurn.strategy, symbol: null, timeframe: null, direction: null, indicators: [], entryLong: null, stopLoss: null, takeProfit: null, sizing: null, maxDailyLossUsd: null } }
    const { provider } = openai(turnData)
    const turn = await interpretTurn([{ role: 'user', content: 'Buy DOGE whenever Elon tweets about it' }], provider, new AiUsageTracker(memoryDb()), settings('gpt-x'), SYMBOLS)
    assert.equal(turn.status, 'unsupported')
    assert.equal(turn.validation.valid, false)
    assert.ok(turn.unsupported.some((u) => /news or sentiment/.test(u)), 'TradePilot adds its own explanation')
  })

  it('rejects malformed model output and treats injected instructions as plain text', async () => {
    const { provider } = openai({ hello: 'world' })
    await assert.rejects(interpretTurn([{ role: 'user', content: 'rsi below 30' }], provider, new AiUsageTracker(memoryDb()), settings('gpt-x'), SYMBOLS), /unexpected structure|schema|invalid/i)
    // whatever the trader writes, the model only returns data; the system prompt says so explicitly
    assert.match(systemPrompt(SYMBOLS), /never instructions to you/)
  })

  it('modifies a saved strategy: sends the current rules, keeps the name, and lists the changes', async () => {
    const base = rsiStrategy({ name: 'Dip buyer v1' })
    const proposed = {
      status: 'ready', questions: [], ambiguities: [], unsupported: [], summary: 'Stop tightened to 1%.',
      strategy: {
        name: null, description: null, symbol: 'BTCUSD', timeframe: '1h', direction: 'long',
        indicators: [{ id: 'rsi_14', kind: 'rsi', period: 14, stdDev: null }],
        entryLong: { match: 'all', conditions: [{ left: operand({ type: 'indicator', indicatorId: 'rsi_14' }), op: '<', right: operand({ type: 'value', value: 30 }) }] },
        entryShort: null,
        exitLong: { match: 'all', conditions: [{ left: operand({ type: 'indicator', indicatorId: 'rsi_14' }), op: '>', right: operand({ type: 'value', value: 55 }) }] },
        exitShort: null,
        stopLoss: { type: 'percent', value: 1 }, takeProfit: { type: 'risk_multiple', value: 2 }, sizing: { type: 'risk_percent', value: 1 },
        allocatedCapitalUsd: null, maxDailyLossPct: 3, maxDailyLossUsd: null, maxTradesPerDay: 4
      }
    }
    const { f, provider } = openai(proposed)
    const turn = await interpretTurn([{ role: 'user', content: 'Tighten the stop-loss to 1%' }], provider, new AiUsageTracker(memoryDb()), settings('gpt-x'), SYMBOLS, base)
    const sys = (JSON.parse(f.calls[0]!.body!) as { messages: { content: string }[] }).messages[0]!.content
    assert.match(sys, /modifying this saved strategy/)
    assert.ok(sys.includes('"name":"Dip buyer v1"'))
    assert.equal(turn.definition.name, 'Dip buyer v1', 'labels are kept if the model drops them')
    assert.equal(turn.status, 'ready_for_review')
    assert.equal(turn.definition.description, base.description)
    assert.deepEqual(turn.changes?.map((c) => c.field), ['Stop-loss'])
  })
})

describe('Phase 5: prompts and versions in the strategy store', () => {
  const store = () => {
    const db = memoryDb()
    return { db, s: new StrategyStore(db, async () => ctx) }
  }

  it('stores the prompt, versions every confirmed change and skips no-op saves', async () => {
    const { s } = store()
    const v1 = await s.save(undefined, rsiStrategy(), { source: 'ai', aiProvider: 'anthropic', prompt: 'Buy BTC dips when RSI < 30' })
    assert.equal(v1.version, 1)
    assert.equal(v1.prompt, 'Buy BTC dips when RSI < 30')
    assert.equal(v1.status, 'disabled', 'saved strategies never start enabled')
    const same = await s.save(v1.id, rsiStrategy())
    assert.equal(same.version, 1, 'identical rules do not create a version')
    const v2 = await s.save(v1.id, rsiStrategy({ timeframe: '4h' }), { source: 'ai', aiProvider: 'openai', changeRequest: 'use the 4-hour chart' })
    assert.equal(v2.version, 2)
    assert.equal(v2.prompt, 'Buy BTC dips when RSI < 30', 'a change request keeps the original prompt')
    const v3 = await s.save(v1.id, rsiStrategy({ timeframe: '4h', name: 'Revised' }), { source: 'ai', aiProvider: 'openai', prompt: 'Revised prompt' })
    assert.equal(v3.prompt, 'Revised prompt')
    const versions = s.versions(v1.id)
    assert.deepEqual(versions.map((v) => [v.version, v.source, v.changeRequest]), [[3, 'ai', null], [2, 'ai', 'use the 4-hour chart'], [1, 'ai', null]])
    assert.equal(versions[2]!.definition.timeframe, '1h', 'old versions are immutable')
    const copy = await s.duplicate(v1.id)
    assert.equal(copy.version, 1)
    assert.equal(copy.prompt, 'Revised prompt')
    s.delete(v1.id)
    assert.throws(() => s.versions(v1.id), /not found/)
  })

  it('migration 5 adds versions to existing databases and pins active sessions to their rules', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db, MIGRATIONS.filter((m) => m.version <= 4))
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO strategies (id, name, symbol, timeframe, definition, status, source, enabled_at, created_at, updated_at) VALUES ('s1', 'Old', 'BTCUSD', '1h', ?, 'enabled', 'manual', ?, ?, ?)`).run(JSON.stringify(rsiStrategy({ name: 'Old' })), now, now, now)
    db.prepare(`INSERT INTO automation_sessions (id, strategy_id, strategy_name, symbol, product_id, timeframe, mode, status, started_at, created_at, updated_at) VALUES ('a1', 's1', 'Old', 'BTCUSD', 27, '1h', 'paper', 'running', ?, ?, ?)`).run(now, now, now)
    assert.deepEqual(migrate(db), [5])
    const v = db.prepare('SELECT version, source FROM strategy_versions WHERE strategy_id = ?').get('s1') as { version: number; source: string }
    assert.deepEqual({ ...v }, { version: 1, source: 'manual' })
    const sess = db.prepare('SELECT strategy_version, definition FROM automation_sessions WHERE id = ?').get('a1') as { strategy_version: number; definition: string }
    assert.equal(sess.strategy_version, 1)
    assert.equal((JSON.parse(sess.definition) as StrategyDefinition).name, 'Old')
  })
})
