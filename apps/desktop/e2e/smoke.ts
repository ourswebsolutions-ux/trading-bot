/**
 * End-to-end smoke test: real subscription server (in-process) + the built Electron app,
 * driven through its UI. Run with `npm run test:e2e` from the repo root.
 *
 * Uses a throwaway user-data directory and `--password-store=basic`, so it never touches
 * your real TradePilot data or your OS keychain. Requires network access to Delta
 * Exchange's public API (market data + backtest) and python3 on PATH.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { createContext } from '../../server/src/bootstrap.js'
import { loadConfig } from '../../server/src/config.js'
import { buildApp } from '../../server/src/http/app.js'
import { createAdmin } from '../../server/src/services/admins.js'
import { MemoryMailer } from '../../server/src/services/mailer.js'
import { approveRequest } from '../../server/src/services/payments.js'
import { setSetting } from '../../server/src/services/settings.js'
import { explainDefinition, validateDefinition, type StrategyDefinition } from '../src/shared/strategyRules.js'
import type { InterpretationTurn } from '../src/shared/ipc.js'

const require = createRequire(import.meta.url)
const desktopDir = path.resolve(import.meta.dirname, '..')
const shots = process.env.E2E_SCREENSHOT_DIR ?? path.join(tmpdir(), 'tradepilot-e2e-shots')
mkdirSync(shots, { recursive: true })
const PASSWORD = 'Harbor-Lantern-58'

const nav = (page: Page, label: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${label}`) }).click()
const step = (name: string) => console.log(`\n▶ ${name}`)
let app: ElectronApplication
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(shots, `${name}.png`), timeout: 15_000 })
  console.log(`  📸 ${name}.png`)
}

async function main() {
  // ---------- server ----------
  const serverDir = mkdtempSync(path.join(tmpdir(), 'tp-e2e-server-'))
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: serverDir, PUBLIC_BASE_URL: 'http://127.0.0.1:8787' })
  const mailer = new MemoryMailer()
  const ctx = createContext(config, { mailer })
  setSetting(ctx.db, 'admin_notify_email', 'payments@example.test', new Date(), null)
  setSetting(ctx.db, 'payment_instructions', 'Bank transfer\nAccount: TradePilot Ltd · IBAN XX00 0000 0000 0000\nMemo: your reference code', new Date(), null)
  const adminId = await createAdmin(ctx.db, new Date(), { email: 'owner@example.test', displayName: 'Owner', password: 'correct horse battery', role: 'superadmin' })
  const server = await buildApp(ctx)
  await server.listen({ port: 0, host: '127.0.0.1' })
  const apiUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`
  console.log(`server at ${apiUrl}`)

  // ---------- app ----------
  const userData = mkdtempSync(path.join(tmpdir(), 'tp-e2e-userdata-'))
  const proof = path.join(userData, 'proof.png')
  writeFileSync(proof, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a8f30000000049454e44ae426082', 'hex'))
  // Editors such as VS Code export ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
  const { ELECTRON_RUN_AS_NODE: _drop, ...parentEnv } = process.env
  app = await electron.launch({
    executablePath: require('electron') as unknown as string,
    args: [desktopDir, '--password-store=basic'],
    env: {
      ...(parentEnv as Record<string, string>),
      TRADEPILOT_API_URL: apiUrl,
      TRADEPILOT_ENTITLEMENT_PUBLIC_KEY: ctx.keys.publicKeyBase64,
      TRADEPILOT_USER_DATA_DIR: userData,
      TRADEPILOT_E2E_HIDDEN: '1',
      ELECTRON_RENDERER_URL: ''
    }
  })
  let page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900))
  page.on('pageerror', (e) => console.error('  renderer error:', e.message))

  try {
    step('welcome screen (5 s, skippable)')
    await page.getByText('Rule-based trading, research and automation').waitFor()
    await page.waitForTimeout(1800)
    await shot(page, '00-welcome')
    await page.locator('.welcome').click()

    step('first-run password setup, with show/hide password and a live market chart')
    await page.getByRole('heading', { name: 'Create your password' }).waitFor()
    await page.getByLabel('Password', { exact: true }).fill('peek-a-boo')
    await page.getByRole('button', { name: 'Show password' }).first().click()
    assert.equal(await page.getByLabel('Password', { exact: true }).getAttribute('type'), 'text')
    await page.getByRole('button', { name: 'Hide password' }).first().click()
    assert.equal(await page.getByLabel('Password', { exact: true }).getAttribute('type'), 'password')
    await page.locator('.auth-market .chart svg rect').first().waitFor({ timeout: 30_000 })
    await shot(page, '01-setup')
    await page.getByLabel('Password', { exact: true }).fill('short')
    await page.getByLabel('Confirm password').fill('short')
    await page.getByRole('button', { name: 'Create password and continue' }).click()
    await page.getByText('at least 10 characters').first().waitFor()
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByLabel('Confirm password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create password and continue' }).click()

    step('dashboard: trial registered with the server, live market data')
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor()
    await page.getByText(/Synced/).first().waitFor({ timeout: 20_000 })
    await page.getByText('Free trial').first().waitFor()
    await page.locator('table.data tbody tr').first().waitFor({ timeout: 30_000 })
    await page.locator('.chart svg rect').first().waitFor({ timeout: 30_000 })
    step('dashboard: live price streamed over WebSocket')
    await page.locator('.quote-line .badge', { hasText: 'Live' }).first().waitFor({ timeout: 30_000 })
    await page.getByText('Streaming').first().waitFor({ timeout: 30_000 })
    await shot(page, '02-dashboard')

    step('strategies: the prompt workspace asks for an AI provider when none is configured')
    await nav(page, 'Strategies')
    await page.getByRole('button', { name: 'New strategy from prompt' }).first().click()
    await page.getByText('Connect an AI provider first').waitFor()
    await shot(page, '03a-prompt-studio-no-provider')
    await page.getByRole('button', { name: 'Back', exact: true }).click()

    step('strategies: build, validate and enable a rule-based strategy')
    await page.getByRole('button', { name: 'Build a strategy' }).click()
    await page.getByLabel('Name', { exact: true }).fill('BTC RSI dip buyer')
    await page.getByRole('button', { name: 'Add indicator' }).click()
    await page.getByRole('button', { name: 'Add condition' }).first().click()
    await page.getByPlaceholder('value').first().fill('30')
    await page.getByLabel(/^Stop-loss/).selectOption('percent')
    await page.getByLabel(/^Stop distance/).fill('2')
    await page.getByLabel('Position sizing').selectOption('risk_percent')
    await page.getByLabel('Size', { exact: true }).fill('1')
    await page.getByText(/Set a maximum daily loss/).first().waitFor()
    assert.equal(await page.getByRole('button', { name: 'Save and enable' }).isDisabled(), true, 'cannot enable while invalid')
    await shot(page, '03-strategy-builder-invalid')
    await page.getByLabel('Maximum daily loss (% of equity)').fill('3')
    await page.getByLabel('Maximum trades per day').fill('4')
    await page.getByText('All checks passed').waitFor()
    await page.getByText(/Buy \(go long\) BTCUSD when the 14-candle RSI/).waitFor()
    await shot(page, '03b-strategy-builder-valid')
    await page.getByRole('button', { name: 'Save and enable' }).click()
    await page.getByText('Strategy saved and enabled').waitFor()
    await page.getByText(/This strategy passed validation\./).waitFor()
    await page.getByText(/built in the advanced builder, without a prompt/).waitFor()
    await page.getByText('Versions (1)').waitFor()
    await shot(page, '04-strategy-details')

    step('strategies: an edit creates a new version and keeps the old one')
    await page.getByRole('button', { name: 'Advanced edit' }).click()
    await page.getByText(/Saving changes creates version 2/).waitFor()
    await page.getByLabel('Maximum trades per day').fill('5')
    await page.getByText('All checks passed').waitFor()
    await page.getByRole('button', { name: 'Save changes' }).click()
    await page.getByText('Versions (2)').waitFor()
    await page.getByRole('button', { name: /^v1/ }).click()
    await shot(page, '04b-strategy-versions')

    step('analytics: rule-based backtest through the Python engine')
    await page.getByRole('button', { name: 'Backtest', exact: true }).click()
    await page.getByRole('button', { name: 'Run backtest' }).click()
    await page.getByText('Total return').waitFor({ timeout: 120_000 })
    await page.getByText('SIMULATED', { exact: true }).waitFor()
    await page.getByText('Net P&L').waitFor()
    await page.getByText(/slippage 2 bps per fill/).waitFor()
    await shot(page, '05-analytics')

    step('trading: live balance strip, risk settings, paper automation and emergency stop')
    await nav(page, 'Trading')
    await page.getByText('Exchange balance').waitFor()
    await page.getByRole('button', { name: 'Save risk settings' }).click()
    await page.getByText('Risk settings saved').first().waitFor()
    await page.getByRole('button', { name: 'Start paper' }).click()
    await page.getByText('Paper automation started', { exact: true }).waitFor()
    await page.getByText('Running', { exact: true }).waitFor()
    await shot(page, '06a-automation')
    await page.getByRole('button', { name: 'Emergency stop' }).first().click()
    await page.getByRole('button', { name: 'Stop everything now' }).click()
    await page.getByText(/Emergency stop active since/).waitFor({ timeout: 20_000 })
    await page.getByText('Not running').waitFor()
    await shot(page, '06b-emergency')
    await page.getByRole('button', { name: 'Clear emergency stop' }).click()
    await page.getByText('Emergency stop cleared').first().waitFor()
    await page.getByRole('tab', { name: 'Orders & trades' }).click()
    await page.getByRole('heading', { name: 'Automated orders' }).waitFor()

    step('trading: manual paper order')
    await page.getByRole('tab', { name: 'Manual paper trading' }).click()
    const buy = page.getByRole('button', { name: /^Buy 0\.01/ })
    await buy.waitFor()
    await page.waitForFunction(() => !document.querySelector('form button[type=submit].btn.buy')?.hasAttribute('disabled'), null, { timeout: 30_000 })
    await buy.click()
    await page.getByRole('button', { name: 'Place paper buy' }).click()
    await page.getByText('Paper buy filled').waitFor({ timeout: 20_000 })
    await page.getByRole('cell', { name: 'flat' }).or(page.getByRole('button', { name: 'Close' })).first().waitFor()
    await shot(page, '06-trading')

    step('subscription: submit payment, admin approves, access restored')
    await nav(page, 'Subscription')
    await page.getByText('$20').first().waitFor()
    await page.getByText('$500').first().waitFor()
    await shot(page, '07-subscription-plans')
    await page.getByRole('button', { name: 'Choose Monthly' }).click()
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
    }, proof)
    await page.getByLabel('Transaction ID').fill('E2E-TXN-000123')
    await page.getByRole('button', { name: 'Choose screenshot…' }).click()
    await page.getByText('proof.png').waitFor()
    await shot(page, '08-payment-form')
    await page.getByRole('button', { name: 'Submit for review' }).click()
    await page.getByRole('button', { name: 'Submit request' }).click()
    await page.getByText('Payment under review').waitFor({ timeout: 20_000 })
    await page.getByText('Pending review', { exact: true }).waitFor()
    await ctx.notifier.idle()
    assert.ok(mailer.sent.some((m) => m.subject.includes('New Monthly payment request')), 'admin notified by email')
    const pending = ctx.db.prepare(`SELECT id FROM payment_requests WHERE status = 'pending'`).get() as { id: string }
    approveRequest(ctx, { id: adminId, email: 'owner@example.test', ip: null }, pending.id)
    await page.getByRole('button', { name: 'Refresh' }).click()
    await page.getByText('Approved', { exact: true }).waitFor({ timeout: 20_000 })
    await page.getByText('Monthly').first().waitFor()
    await shot(page, '09-subscription-active')

    step('notifications (bell icon; the tab was removed)')
    assert.equal(await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Notifications/ }).count(), 0)
    await page.getByRole('button', { name: /^Notifications \(/ }).click()
    await page.getByText('Payment confirmed', { exact: true }).first().waitFor({ timeout: 20_000 })
    await shot(page, '10-notifications')
    await page.getByRole('button', { name: 'Mark all read' }).click()

    step('settings: market data connection test against the real exchange')
    await nav(page, 'Settings')
    await page.getByRole('button', { name: 'Market Data' }).click()
    await page.getByRole('button', { name: 'Test connection' }).click()
    await page.getByText('Market Data: connection OK').waitFor({ timeout: 45_000 })
    await page.getByText(/WebSocket first tick in/).first().waitFor()
    await page.getByText('Last successful connection').waitFor()
    await shot(page, '11-settings-marketdata')

    step('settings: AI assistant preference section')
    await page.getByRole('button', { name: 'AI assistant' }).click()
    await page.getByText('No AI provider connected').waitFor()
    await page.getByLabel('Preferred provider').selectOption('anthropic')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByText('AI preference saved').waitFor()
    await shot(page, '11a-settings-ai')

    step('settings: AI section reports unavailable secure storage honestly')
    await page.getByRole('button', { name: 'OpenAI' }).click()
    await page.getByText('Secure storage unavailable').first().waitFor()
    assert.equal(await page.getByLabel('API key').isDisabled(), true, 'credentials cannot be typed without secure storage')
    await shot(page, '11b-settings-openai')
    await page.getByRole('button', { name: 'Updates' }).click()
    await page.getByText(/Development build/).waitFor()
    await shot(page, '12-settings-updates')

    step('light theme')
    await page.getByRole('button', { name: 'General' }).click()
    await page.getByLabel('Theme').selectOption('light')
    await page.getByRole('button', { name: 'Save preferences' }).click()
    await page.getByText('Preferences saved').waitFor()
    await nav(page, 'Dashboard')
    await page.locator('.chart svg rect').first().waitFor({ timeout: 30_000 })
    await shot(page, '13-dashboard-light')

    step('lock, failed unlock, unlock')
    await page.getByRole('button', { name: 'Lock', exact: true }).click()
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
    await page.getByLabel('Password', { exact: true }).fill('wrong-password-1')
    await page.getByRole('button', { name: 'Unlock' }).click()
    await page.getByText(/Incorrect password\. 4 attempts/).waitFor()
    await shot(page, '14-locked')
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Unlock' }).click()
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor()

    step('strategies: prompt-first creation (AI provider replaced by a test stub; validation and saving are real)')
    {
      const prompt = 'Trade BTC when the 15-minute trend is bullish and RSI crosses above 30. Use 2% of my allocated trading capital per trade, set stop-loss at 1.5%, take-profit at 3%, and stop opening new trades after a daily loss of $20.'
      const rsiUp = { left: { type: 'indicator', id: 'rsi_14' }, op: 'crosses_above', right: { type: 'value', value: 30 } } as const
      const draft: StrategyDefinition = {
        version: 2, name: 'BTC RSI trend entry', description: '', symbol: 'BTCUSD', timeframe: '15m', direction: 'long',
        indicators: [{ id: 'rsi_14', kind: 'rsi', period: 14 }],
        entry: { long: { match: 'all', conditions: [rsiUp] }, short: null }, exit: { long: null, short: null },
        risk: { stopLoss: { type: 'percent', value: 1.5 }, takeProfit: { type: 'percent', value: 3 }, sizing: { type: 'percent_equity', value: 2 }, maxDailyLossPct: null, maxDailyLossUsd: 20, maxTradesPerDay: null, allocatedCapitalUsd: null, feeBps: 5 }
      }
      const done: StrategyDefinition = {
        ...draft,
        indicators: [...draft.indicators, { id: 'ema_50', kind: 'ema', period: 50 }],
        entry: { long: { match: 'all', conditions: [rsiUp, { left: { type: 'price', field: 'close' }, op: '>', right: { type: 'indicator', id: 'ema_50' } }] }, short: null },
        risk: { ...draft.risk, allocatedCapitalUsd: 1000, maxTradesPerDay: 3 }
      }
      const vctx = { instruments: ['BTCUSD'] }
      const turn = (d: StrategyDefinition, over: Partial<InterpretationTurn>): InterpretationTurn => ({
        status: 'needs_clarification', questions: [], missing: [], ambiguities: [], unsupported: [], definition: d, validation: validateDefinition(d, vctx), explanation: explainDefinition(d),
        aiSummary: '', assistantMessage: '{}', provider: 'anthropic', model: 'stub (e2e)', usage: { inputTokens: 0, outputTokens: 0 }, changes: null, ...over
      })
      const turns = [
        turn(draft, {
          questions: ['How should "the 15-minute trend is bullish" be defined: close above the 50-period EMA, or the 20 EMA above the 50 EMA?', 'How much capital (USD) is allocated to this strategy?'],
          missing: ['What is the maximum number of trades per day?'],
          ambiguities: ['"trend is bullish" has no exact definition'],
          aiSummary: 'Buy BTCUSD on 15-minute candles when RSI(14) crosses above 30; 2% of allocated capital, 1.5% stop, 3% target, $20 daily loss. Trend definition, capital and trade limit are open.'
        }),
        turn(done, { status: 'ready_for_review', aiSummary: 'Trend = close above EMA 50; $1,000 allocated; 3 trades per day.' })
      ]
      assert.equal(turns[1]!.validation.valid, true, JSON.stringify(turns[1]!.validation.errors))
      await app.evaluate(({ ipcMain }, stubTurns) => {
        let n = 0
        ipcMain.removeHandler('integrations:list')
        ipcMain.handle('integrations:list', async () => ({ ok: true, data: [{ id: 'anthropic', state: 'connected', message: null, checkedAt: null, lastSuccessAt: null, lastAction: null, config: { model: 'stub (e2e)' }, secrets: {} }] }))
        ipcMain.removeHandler('ai:interpretStrategy')
        ipcMain.handle('ai:interpretStrategy', async () => ({ ok: true, data: stubTurns[Math.min(n++, stubTurns.length - 1)] }))
      }, turns)
      await nav(page, 'Strategies')
      await page.getByRole('button', { name: 'New strategy from prompt' }).click()
      await page.getByLabel('Describe your strategy').fill(prompt)
      await page.getByRole('button', { name: 'Interpret prompt' }).click()
      await page.getByText('More information needed').waitFor()
      await page.getByText(/How should "the 15-minute trend is bullish" be defined/).first().waitFor()
      assert.equal(await page.getByRole('button', { name: 'Confirm and save' }).isDisabled(), true, 'cannot save while questions are open')
      await shot(page, '16a-prompt-studio-questions')
      await page.getByLabel('Answer the questions').fill('Bullish trend = close above the 50 EMA. I allocate $1,000. At most 3 trades a day.')
      await page.getByRole('button', { name: 'Send answer' }).click()
      await page.getByText('Ready for your review').waitFor()
      await page.getByText(/2% of the \$1,000 allocated capital/).first().waitFor()
      await page.getByText('All checks passed').waitFor()
      assert.equal(await page.getByRole('button', { name: 'Confirm and save' }).isDisabled(), true, 'needs explicit confirmation')
      await page.getByLabel(/I reviewed these rules/).check()
      await shot(page, '16b-prompt-studio-review')
      await page.getByRole('button', { name: 'Confirm and save' }).click()
      await page.getByText('Strategy saved (disabled)').waitFor()
      await page.getByText(prompt.slice(0, 40)).first().waitFor()
      await page.getByText('Disabled', { exact: true }).first().waitFor()
      await shot(page, '16c-strategy-from-prompt')
    }

    step('restart: strategies persist')
    await app.close()
    app = await electron.launch({
      executablePath: require('electron') as unknown as string,
      args: [desktopDir, '--password-store=basic'],
      env: { ...(parentEnv as Record<string, string>), TRADEPILOT_API_URL: apiUrl, TRADEPILOT_ENTITLEMENT_PUBLIC_KEY: ctx.keys.publicKeyBase64, TRADEPILOT_USER_DATA_DIR: userData, TRADEPILOT_E2E_HIDDEN: '1', ELECTRON_RENDERER_URL: '' }
    })
    page = await app.firstWindow()
    await page.locator('.welcome').click()
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Unlock' }).click()
    await nav(page, 'Strategies')
    await page.getByRole('cell', { name: /BTC RSI dip buyer/ }).waitFor()
    await page.getByText('Enabled', { exact: true }).first().waitFor()
    await shot(page, '15-strategies-after-restart')

    console.log(`\n✔ e2e smoke test passed — screenshots in ${shots}`)
  } catch (err) {
    await shot(page, 'failure').catch(() => undefined)
    throw err
  } finally {
    await app.close()
    await server.close()
    await ctx.notifier.idle()
    ctx.db.close()
    rmSync(serverDir, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('\n✖ e2e smoke test failed:', err)
  process.exit(1)
})
