import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AnthropicProvider } from '../src/main/ai/anthropic.js'
import { OpenAiProvider } from '../src/main/ai/openai.js'
import { AiUsageTracker, runJson, type AiJsonRequest, type AiSettings } from '../src/main/ai/provider.js'
import { INTERPRETATION_SCHEMA, interpretTurn } from '../src/main/ai/strategyInterpreter.js'
import type { ChatMessage } from '../src/shared/ipc.js'
import { fakeFetch, memoryDb, noSleep } from './helpers.js'

const settings = (model: string, over: Partial<AiSettings> = {}): AiSettings => ({ model, maxOutputTokens: 1024, timeoutSec: 30, dailyRequestLimit: 3, dailyTokenLimit: 100_000, ...over })
const req = (over: Partial<AiJsonRequest> = {}): AiJsonRequest => ({ purpose: 't', system: 's', messages: [{ role: 'user', content: 'u' }], schemaName: 'x', schema: {}, ...over })
const SYMBOLS = ['BTCUSD', 'ETHUSD']

const operand = (o: Partial<{ type: string; indicatorId: string; priceField: string; value: number }>) => ({ type: 'value', indicatorId: null, priceField: null, value: null, ...o })
const rsiBelow = (v: number) => ({ match: 'all', conditions: [{ left: operand({ type: 'indicator', indicatorId: 'rsi_14' }), op: '<', right: operand({ type: 'value', value: v }) }] })
const emptyStrategy = { name: null, description: null, symbol: null, timeframe: null, direction: null, indicators: [], entryLong: null, entryShort: null, exitLong: null, exitShort: null, stopLoss: null, takeProfit: null, sizing: null, maxDailyLossPct: null, maxTradesPerDay: null }

/** What a well-behaved model returns for the EUR/USD example. */
const firstTurn = {
  status: 'needs_clarification',
  questions: ['EUR/USD is not available on Delta Exchange. Which listed contract should be used instead?', 'Pips do not apply here; how far should the 20-pip stop and 40-pip target be in percent or price points?'],
  ambiguities: ['"20-pip stop-loss" and "40-pip take-profit" use forex units'],
  unsupported: ['EUR/USD (forex pair)'],
  summary: 'Buy when RSI(14) is below 30 with a stop and a target twice as far away; the instrument and units need clarifying.',
  strategy: { ...emptyStrategy, name: 'RSI oversold buyer', direction: 'long', indicators: [{ id: 'rsi_14', kind: 'rsi', period: 14, stdDev: null }], entryLong: rsiBelow(30) }
}
const completeTurn = {
  ...firstTurn,
  status: 'ready',
  questions: [],
  ambiguities: [],
  unsupported: [],
  strategy: { ...firstTurn.strategy, symbol: 'BTCUSD', timeframe: '1h', stopLoss: { type: 'percent', value: 1 }, takeProfit: { type: 'percent', value: 2 }, sizing: { type: 'risk_percent', value: 1 }, maxDailyLossPct: 3, maxTradesPerDay: 5 }
}
const chat = (content: unknown) => [200, { model: 'gpt-x', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 900, completion_tokens: 300 } }] as [number, unknown]

describe('AI strategy interpretation', () => {
  it('flags unsupported instruments, asks for clarification and never fills in missing rules', async () => {
    const f = fakeFetch(() => chat(firstTurn))
    const tracker = new AiUsageTracker(memoryDb())
    const messages: ChatMessage[] = [{ role: 'user', content: 'Buy EUR/USD when RSI is below 30, use a 20-pip stop-loss and a 40-pip take-profit.' }]
    const turn = await interpretTurn(messages, new OpenAiProvider('k', f.impl, noSleep), tracker, settings('gpt-x'), SYMBOLS)
    assert.equal(turn.status, 'needs_clarification')
    assert.equal(turn.unsupported[0], 'EUR/USD (forex pair)')
    assert.match(turn.unsupported[1]!, /pips do not apply.*noticed in your description by TradePilot/)
    assert.equal(turn.questions.length, 2)
    // TradePilot's own completeness check, independent of the model
    for (const re of [/contract/, /timeframe/, /stop-loss/, /How large/, /maximum loss per day/, /maximum number of trades/]) assert.ok(turn.missing.some((m) => re.test(m)), String(re))
    assert.equal(turn.definition.symbol, '')
    assert.equal(turn.definition.risk.stopLoss, null)
    assert.equal(turn.definition.risk.sizing, null)
    assert.equal(turn.validation.valid, false)
    assert.match(turn.explanation.entry[0]!, /RSI \(0–100\) is below 30/)
    const body = JSON.parse(f.calls[0]!.body!)
    assert.deepEqual(body.response_format.json_schema.schema, INTERPRETATION_SCHEMA)
    assert.equal(body.response_format.json_schema.strict, true)
    assert.match(body.messages[0].content, /Never invent anything/)
    assert.match(body.messages[0].content, /BTCUSD, ETHUSD/)
  })

  it('continues the conversation and produces validated rules once everything is answered', async () => {
    const f = fakeFetch(() => chat(completeTurn))
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Buy EUR/USD when RSI is below 30, use a 20-pip stop-loss and a 40-pip take-profit.' },
      { role: 'assistant', content: JSON.stringify(firstTurn) },
      { role: 'user', content: 'Use BTCUSD on 1h, stop 1%, target 2%, risk 1% per trade, max 3% loss and 5 trades per day.' }
    ]
    const turn = await interpretTurn(messages, new OpenAiProvider('k', f.impl, noSleep), new AiUsageTracker(memoryDb()), settings('gpt-x'), SYMBOLS)
    assert.equal(turn.status, 'ready_for_review')
    assert.deepEqual(turn.missing, [])
    assert.equal(turn.validation.valid, true)
    assert.equal(turn.definition.symbol, 'BTCUSD')
    assert.deepEqual(turn.definition.risk.stopLoss, { type: 'percent', value: 1 })
    const sent = JSON.parse(f.calls[0]!.body!).messages
    assert.deepEqual(sent.map((m: { role: string }) => m.role), ['system', 'user', 'assistant', 'user'])
    assert.equal(JSON.parse(turn.assistantMessage).status, 'ready')
  })

  it('does not trust a model that claims "ready" while required rules are missing or contradictory', async () => {
    const noStop = { ...completeTurn, strategy: { ...completeTurn.strategy, stopLoss: null, maxDailyLossPct: null } }
    const t1 = await interpretTurn([{ role: 'user', content: 'rsi under 30 on BTC' }], new OpenAiProvider('k', fakeFetch(() => chat(noStop)).impl), new AiUsageTracker(memoryDb()), settings('gpt-x'), SYMBOLS)
    assert.equal(t1.status, 'needs_clarification')
    assert.ok(t1.missing.some((m) => /stop-loss/.test(m)))
    assert.ok(t1.missing.some((m) => /maximum loss per day/.test(m)))

    const contradictory = { ...completeTurn, strategy: { ...completeTurn.strategy, entryLong: { match: 'all', conditions: [...rsiBelow(30).conditions, { left: operand({ type: 'indicator', indicatorId: 'rsi_14' }), op: '>', right: operand({ type: 'value', value: 70 }) }] } } }
    const t2 = await interpretTurn([{ role: 'user', content: 'rsi under 30 and over 70' }], new OpenAiProvider('k', fakeFetch(() => chat(contradictory)).impl), new AiUsageTracker(memoryDb()), settings('gpt-x'), SYMBOLS)
    assert.equal(t2.status, 'needs_clarification')
    assert.match(t2.validation.errors.map((e) => e.message).join(' '), /contradict/)
  })

  it('rejects an empty conversation without calling the provider', async () => {
    const f = fakeFetch(() => chat(completeTurn))
    await assert.rejects(interpretTurn([], new OpenAiProvider('k', f.impl), new AiUsageTracker(memoryDb()), settings('gpt-x'), SYMBOLS), /Send a message/)
    assert.equal(f.calls.length, 0)
  })
})

describe('OpenAI provider', () => {
  it('lists only chat-capable models and authenticates with a bearer token', async () => {
    const f = fakeFetch(() => [200, { data: [{ id: 'gpt-x', created: 2 }, { id: 'text-embedding-3-large', created: 3 }, { id: 'o9-mini', created: 1 }, { id: 'gpt-x-realtime', created: 4 }] }])
    const models = await new OpenAiProvider('sk-test-key-123456', f.impl, noSleep).listModels()
    assert.deepEqual(models.map((m) => m.id), ['gpt-x', 'o9-mini'])
    assert.equal(f.calls[0]!.headers.authorization, 'Bearer sk-test-key-123456')
  })

  it('maps refusals, truncation, auth and quota errors and records failures', async () => {
    const tracker = new AiUsageTracker(memoryDb())
    const cases: [[number, unknown], RegExp][] = [
      [[200, { choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'cannot help' } }] }], /declined/],
      [[200, { choices: [{ finish_reason: 'length', message: { content: '{"a' } }] }], /output-token limit/],
      [[401, { error: { message: 'bad key' } }], /rejected the API key/],
      [[429, { error: { code: 'insufficient_quota', message: 'quota' } }], /quota exhausted/]
    ]
    for (const [response, re] of cases) {
      await assert.rejects(runJson(new OpenAiProvider('k', fakeFetch(() => response).impl, noSleep), tracker, req(), settings('gpt-x', { dailyRequestLimit: 100 })), re)
    }
    assert.equal(tracker.summary('openai', settings('gpt-x')).failedToday, 4)
  })

  it('blocks requests once the daily request limit is reached and tracks tokens', async () => {
    const tracker = new AiUsageTracker(memoryDb())
    const f = fakeFetch(() => chat({ ok: true }))
    const p = new OpenAiProvider('k', f.impl)
    for (let i = 0; i < 3; i++) await runJson(p, tracker, req(), settings('gpt-x'))
    await assert.rejects(runJson(p, tracker, req(), settings('gpt-x')), /request limit reached/)
    assert.equal(f.calls.length, 3, 'the fourth request never left the app')
    assert.equal(tracker.summary('openai', settings('gpt-x')).tokensToday, 3600)
  })
})

describe('Anthropic provider (official SDK)', () => {
  const message = (text: string, stop = 'end_turn') => [200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 400, output_tokens: 90 } }] as [number, unknown]

  it('sends the conversation with structured output, low effort and refusal fallbacks', async () => {
    const f = fakeFetch(() => message(JSON.stringify(completeTurn)))
    const messages: ChatMessage[] = [{ role: 'user', content: 'Buy BTC when RSI is under 30' }, { role: 'assistant', content: '{}' }, { role: 'user', content: '1h, stop 1%, target 2%, risk 1%, max 3% loss and 5 trades a day' }]
    const turn = await interpretTurn(messages, new AnthropicProvider('sk-ant-fake', f.impl), new AiUsageTracker(memoryDb()), settings('claude-opus-5-5'), SYMBOLS)
    const call = f.calls[0]!
    const body = JSON.parse(call.body!)
    assert.match(call.headers['anthropic-beta'] ?? '', /server-side-fallback-2026-07-01/)
    assert.equal(body.fallbacks, 'default')
    assert.deepEqual(body.output_config, { format: { type: 'json_schema', schema: INTERPRETATION_SCHEMA }, effort: 'low' })
    assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ['user', 'assistant', 'user'])
    assert.equal(turn.provider, 'anthropic')
    assert.equal(turn.status, 'ready_for_review')
  })

  it('omits fallbacks and effort for models that do not support them, and handles refusals', async () => {
    const f = fakeFetch(() => message('{}'))
    await runJson(new AnthropicProvider('k', f.impl), new AiUsageTracker(memoryDb()), req(), settings('claude-haiku-4-5'))
    const body = JSON.parse(f.calls[0]!.body!)
    assert.equal(body.fallbacks, undefined)
    assert.equal(body.output_config.effort, undefined)
    await assert.rejects(runJson(new AnthropicProvider('k', fakeFetch(() => message('', 'refusal')).impl), new AiUsageTracker(memoryDb()), req(), settings('claude-opus-5-5')), /declined/)
    await assert.rejects(runJson(new AnthropicProvider('k', fakeFetch(() => [401, { type: 'error', error: { type: 'authentication_error', message: 'x' } }]).impl), new AiUsageTracker(memoryDb()), req(), settings('claude-opus-5-5')), /rejected the API key/)
  })

  it('lists models through the Models API', async () => {
    const f = fakeFetch(() => [200, { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', type: 'model', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'a', last_id: 'a' }])
    assert.deepEqual(await new AnthropicProvider('k', f.impl).listModels(), [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }])
  })
})
