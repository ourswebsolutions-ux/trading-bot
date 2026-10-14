/**
 * Live integration tests against real providers: `npm run test:live -w @tradepilot/desktop`.
 * Public Delta Exchange market data always runs (needs network). Credentialed checks run only
 * when their environment variables are set and are skipped (not faked) otherwise:
 *   DELTA_REGION, DELTA_API_KEY, DELTA_API_SECRET
 *   OPENAI_API_KEY · ANTHROPIC_API_KEY (optional OPENAI_MODEL / ANTHROPIC_MODEL)
 *   SMTP_TEST_HOST, SMTP_TEST_PORT, SMTP_TEST_SECURE, SMTP_TEST_USER, SMTP_TEST_PASSWORD, SMTP_TEST_FROM, SMTP_TEST_TO
 *   WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TOKEN, (optional) WHATSAPP_WABA_ID
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sendSmtp, verifySmtp } from '@tradepilot/shared/smtp'
import { AnthropicProvider } from '../src/main/ai/anthropic.js'
import { OpenAiProvider } from '../src/main/ai/openai.js'
import { AiUsageTracker } from '../src/main/ai/provider.js'
import { interpretTurn } from '../src/main/ai/strategyInterpreter.js'
import { openDatabase } from '../src/main/db.js'
import { WhatsAppClient } from '../src/main/channels/whatsapp.js'
import { DeltaRest } from '../src/main/delta/rest.js'
import { isRegion } from '../src/main/delta/regions.js'
import { MarketDataService } from '../src/main/marketData.js'

const env = process.env
const region = isRegion(env.DELTA_REGION) ? env.DELTA_REGION : 'india'

describe(`Delta Exchange public market data (${region}, live)`, () => {
  it('discovers instruments, reads tickers with current timestamps, and fetches candles', async () => {
    const rest = new DeltaRest(region)
    const products = await rest.products()
    assert.ok(products.length > 0)
    const sym = products.find((p) => p.symbol.startsWith('BTC'))?.symbol ?? products[0]!.symbol
    const t = await rest.ticker(sym)
    const ageSec = Date.now() / 1000 - t.timestamp! / 1_000_000
    console.log(`  ${products.length} perpetuals; ${sym} mark ${t.mark_price} age ${ageSec.toFixed(1)}s`)
    assert.ok(ageSec < 120, `ticker timestamp should be current (age ${ageSec}s)`)
    const end = Math.floor(Date.now() / 1000)
    const candles = await rest.candles(sym, '1h', end - 86400, end)
    assert.ok(candles.length >= 20)
  })

  it('streams live ticks over WebSocket within seconds and classifies them as live', async () => {
    const svc = new MarketDataService({ region: () => region, settings: () => ({ useWebSocket: true, staleAfterSec: 15, pollIntervalSec: 10 }), onSnapshot: () => {}, onCandle: () => {} })
    const products = await svc.instruments()
    const sym = products.find((p) => p.symbol.startsWith('BTC'))?.symbol ?? products[0]!.symbol
    svc.start()
    svc.watch('live-test', [sym])
    const started = Date.now()
    let q
    while (Date.now() - started < 20_000) {
      q = svc.snapshot().quotes[sym]
      if (q?.source === 'websocket') break
      await new Promise((r) => setTimeout(r, 250))
    }
    svc.stop()
    assert.equal(q?.source, 'websocket', 'received a streamed tick')
    assert.equal(q?.state, 'live')
    console.log(`  first streamed ${sym} tick after ${((Date.now() - started) / 1000).toFixed(1)}s, exchange time ${q?.exchangeTime}`)
  })

  it('reports test credentials as rejected by the real API', async () => {
    const rest = new DeltaRest(region, { apiKey: 'definitely-not-a-key', apiSecret: 'nope' })
    await assert.rejects(rest.balances(), (e: Error & { kind?: string }) => e.kind === 'auth' || e.kind === 'permission')
  })
})

describe('real providers reject invalid credentials with the mapped error', () => {
  it('OpenAI → auth', async () => {
    await assert.rejects(new OpenAiProvider('sk-invalid-tradepilot-test').test(), (e: Error & { code?: string }) => e.code === 'auth')
  })
  it('Anthropic → auth', async () => {
    await assert.rejects(new AnthropicProvider('sk-ant-invalid-tradepilot-test').test(), (e: Error & { code?: string }) => e.code === 'auth')
  })
  it('WhatsApp Cloud API → auth (code 190)', async () => {
    await assert.rejects(new WhatsAppClient({ phoneNumberId: '1234567890', apiVersion: 'v23.0' }, 'EAAinvalidtoken000000000000').phoneNumber(), (e: Error & { kind?: string; providerCode?: string }) => {
      console.log(`  Meta replied: ${e.message}`)
      return e.kind === 'auth' || e.kind === 'invalid_request'
    })
  })
})

describe('Delta Exchange testnet order round trip (opt-in)', () => {
  const enabled = env.TRADEPILOT_TESTNET_ORDER_TEST === '1' && region === 'india_testnet' && env.DELTA_API_KEY && env.DELTA_API_SECRET
  it('places 1 contract with bracket stop/target, finds it by client order id, then closes it reduce-only', { skip: !enabled && 'set DELTA_REGION=india_testnet, DELTA_API_KEY/SECRET and TRADEPILOT_TESTNET_ORDER_TEST=1' }, async () => {
    const rest = new DeltaRest('india_testnet', { apiKey: env.DELTA_API_KEY!, apiSecret: env.DELTA_API_SECRET! })
    const products = await rest.products()
    const p = products.find((x) => x.symbol === (env.TESTNET_SYMBOL ?? 'BTCUSD')) ?? products[0]!
    const t = await rest.ticker(p.symbol)
    const mark = t.mark_price!
    const cid = `tptest${Date.now().toString(36)}`.slice(0, 32)
    const tick = p.tick_size
    const round = (x: number) => (Math.round(x / tick) * tick).toFixed(Math.max(0, Math.ceil(-Math.log10(tick))))
    const order = await rest.placeMarketOrder({ productId: p.id, side: 'buy', size: 1, clientOrderId: cid, reduceOnly: false, stopLossPrice: round(mark * 0.97), takeProfitPrice: round(mark * 1.03) })
    console.log(`  placed ${p.symbol} buy 1: state ${order.state}, avg ${order.average_fill_price}, fee ${order.paid_commission}`)
    const found = await rest.orderByClientId(cid)
    assert.equal(found?.client_order_id, cid)
    const pos = await rest.position(p.id)
    assert.ok(pos.size >= 1)
    const close = await rest.placeMarketOrder({ productId: p.id, side: 'sell', size: Math.abs(pos.size), clientOrderId: `${cid}x`.slice(0, 32), reduceOnly: true })
    console.log(`  closed: state ${close.state}, avg ${close.average_fill_price}`)
    await rest.cancelAllOrders(p.id, true)
    assert.equal((await rest.position(p.id)).size, 0)
  })
})

describe('credentialed providers (skipped without credentials)', () => {
  it('Delta Exchange account (read-only)', { skip: !(env.DELTA_API_KEY && env.DELTA_API_SECRET) && 'DELTA_API_KEY/SECRET not set' }, async () => {
    const rest = new DeltaRest(region, { apiKey: env.DELTA_API_KEY!, apiSecret: env.DELTA_API_SECRET! })
    const [balances, positions, orders] = await Promise.all([rest.balances(), rest.positions(), rest.orderHistory(5)])
    console.log(`  balances ${balances.length}, positions ${positions.length}, recent orders ${orders.length}`)
  })

  it('OpenAI', { skip: !env.OPENAI_API_KEY && 'OPENAI_API_KEY not set' }, async () => {
    console.log('  ' + (await new OpenAiProvider(env.OPENAI_API_KEY!).test()))
  })

  it('Anthropic', { skip: !env.ANTHROPIC_API_KEY && 'ANTHROPIC_API_KEY not set' }, async () => {
    console.log('  ' + (await new AnthropicProvider(env.ANTHROPIC_API_KEY!).test()))
  })

  it('SMTP', { skip: !(env.SMTP_TEST_HOST && env.SMTP_TEST_TO) && 'SMTP_TEST_* not set' }, async () => {
    const s = { host: env.SMTP_TEST_HOST!, port: Number(env.SMTP_TEST_PORT ?? 587), secure: env.SMTP_TEST_SECURE === 'true', requireTLS: true, user: env.SMTP_TEST_USER, password: env.SMTP_TEST_PASSWORD, from: env.SMTP_TEST_FROM ?? env.SMTP_TEST_USER! }
    await verifySmtp(s)
    const r = await sendSmtp(s, { to: env.SMTP_TEST_TO!, subject: 'TradePilot live test', text: 'Live SMTP integration test.' })
    console.log(`  accepted: ${r.accepted.join(', ')} — ${r.response}`)
  })

  it('WhatsApp Business', { skip: !(env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_TOKEN) && 'WHATSAPP_* not set' }, async () => {
    const c = new WhatsAppClient({ phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!, businessAccountId: env.WHATSAPP_WABA_ID, apiVersion: 'v23.0' }, env.WHATSAPP_TOKEN!)
    const p = await c.phoneNumber()
    console.log(`  ${p.verified_name} ${p.display_phone_number}; templates: ${(await c.templates()).length}`)
  })
})

/** Phase 5: the real models interpret the example prompt; it must not be "ready" (trend, capital and trade limit are unstated). */
describe('AI strategy prompts with real providers (skipped without credentials)', () => {
  const prompt = 'Trade BTC when the 15-minute trend is bullish and RSI crosses above 30. Use 2% of my allocated trading capital per trade, set stop-loss at 1.5%, take-profit at 3%, and stop opening new trades after a daily loss of $20.'
  const cases = [
    ['Anthropic', env.ANTHROPIC_API_KEY, (k: string) => new AnthropicProvider(k), env.ANTHROPIC_MODEL ?? 'claude-opus-5-5'],
    ['OpenAI', env.OPENAI_API_KEY, (k: string) => new OpenAiProvider(k), env.OPENAI_MODEL ?? 'gpt-5']
  ] as const
  for (const [name, key, make, model] of cases) {
    it(`${name} interprets the example prompt and asks about what is missing`, { skip: !key && `${name.toUpperCase()}_API_KEY not set`, timeout: 180_000 }, async () => {
      const tracker = new AiUsageTracker(openDatabase(':memory:'))
      const turn = await interpretTurn([{ role: 'user', content: prompt }], make(key!), tracker, { model, maxOutputTokens: 4096, timeoutSec: 120, dailyRequestLimit: 10, dailyTokenLimit: 200_000 }, ['BTCUSD', 'ETHUSD'])
      console.log(`  ${name} ${turn.model}: ${turn.status}; questions: ${turn.questions.join(' | ')}`)
      assert.equal(turn.status, 'needs_clarification')
      assert.equal(turn.definition.timeframe, '15m')
      assert.equal(turn.definition.risk.maxDailyLossUsd, 20)
      assert.deepEqual(turn.definition.risk.stopLoss, { type: 'percent', value: 1.5 })
      assert.equal(turn.validation.valid, false)
    })
  }
})
