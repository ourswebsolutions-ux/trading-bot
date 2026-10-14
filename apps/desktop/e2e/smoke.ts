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
import { _electron as electron, type Page } from 'playwright-core'
import { createContext } from '../../server/src/bootstrap.js'
import { loadConfig } from '../../server/src/config.js'
import { buildApp } from '../../server/src/http/app.js'
import { createAdmin } from '../../server/src/services/admins.js'
import { MemoryMailer } from '../../server/src/services/mailer.js'
import { approveRequest } from '../../server/src/services/payments.js'
import { setSetting } from '../../server/src/services/settings.js'

const require = createRequire(import.meta.url)
const desktopDir = path.resolve(import.meta.dirname, '..')
const shots = process.env.E2E_SCREENSHOT_DIR ?? path.join(tmpdir(), 'tradepilot-e2e-shots')
mkdirSync(shots, { recursive: true })
const PASSWORD = 'Harbor-Lantern-58'

const step = (name: string) => console.log(`\n▶ ${name}`)
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(shots, `${name}.png`) })
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
  const app = await electron.launch({
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
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900))
  page.on('pageerror', (e) => console.error('  renderer error:', e.message))

  try {
    step('first-run password setup')
    await page.getByRole('heading', { name: 'Create your password' }).waitFor()
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
    await shot(page, '02-dashboard')

    step('strategies: create')
    await page.getByRole('button', { name: /^Strategies/ }).click()
    await page.getByRole('button', { name: 'Create your first strategy' }).click()
    await page.getByLabel('Name').fill('BTC hourly trend')
    await shot(page, '03-strategy-editor')
    await page.getByRole('button', { name: 'Create strategy' }).click()
    await page.getByText('Strategy created').waitFor()
    await page.getByRole('cell', { name: /BTC hourly trend/ }).waitFor()
    await shot(page, '04-strategies')

    step('analytics: backtest through the Python engine')
    await page.getByRole('button', { name: 'Backtest', exact: true }).first().click()
    await page.getByRole('button', { name: 'Run backtest' }).click()
    await page.getByText('Total return').waitFor({ timeout: 120_000 })
    await shot(page, '05-analytics')

    step('trading: paper order')
    await page.getByRole('button', { name: /^Trading/ }).click()
    const buy = page.getByRole('button', { name: /^Buy 0\.01/ })
    await buy.waitFor()
    await page.waitForFunction(() => !document.querySelector('form button[type=submit].btn.buy')?.hasAttribute('disabled'), null, { timeout: 30_000 })
    await buy.click()
    await page.getByRole('button', { name: 'Place paper buy' }).click()
    await page.getByText('Paper buy filled').waitFor({ timeout: 20_000 })
    await page.getByRole('cell', { name: 'flat' }).or(page.getByRole('button', { name: 'Close' })).first().waitFor()
    await shot(page, '06-trading')

    step('subscription: submit payment, admin approves, access restored')
    await page.getByRole('button', { name: /^Subscription/ }).click()
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
    await page.getByText('Pending review').waitFor()
    await ctx.notifier.idle()
    assert.ok(mailer.sent.some((m) => m.subject.includes('New Monthly payment request')), 'admin notified by email')
    const pending = ctx.db.prepare(`SELECT id FROM payment_requests WHERE status = 'pending'`).get() as { id: string }
    approveRequest(ctx, { id: adminId, email: 'owner@example.test', ip: null }, pending.id)
    await page.getByRole('button', { name: 'Refresh' }).click()
    await page.getByText('Approved').waitFor({ timeout: 20_000 })
    await page.getByText('Monthly').first().waitFor()
    await shot(page, '09-subscription-active')

    step('notifications')
    await page.getByRole('button', { name: /^Notifications/ }).click()
    await page.getByText('Payment confirmed').waitFor({ timeout: 20_000 })
    await shot(page, '10-notifications')
    await page.getByRole('button', { name: 'Mark all read' }).click()

    step('settings: integrations report unavailable secure storage honestly')
    await page.getByRole('button', { name: /^Settings/ }).click()
    await page.getByRole('button', { name: 'OpenAI' }).click()
    await page.getByText('Secure storage unavailable').first().waitFor()
    await page.getByLabel('API key').fill('sk-not-a-real-key-000000')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByText('Not saved').waitFor()
    await shot(page, '11-settings-integration')
    await page.getByRole('button', { name: 'Updates' }).click()
    await page.getByText(/Development build/).waitFor()
    await shot(page, '12-settings-updates')

    step('light theme')
    await page.getByRole('button', { name: 'General' }).click()
    await page.getByLabel('Theme').selectOption('light')
    await page.getByRole('button', { name: 'Save preferences' }).click()
    await page.getByText('Preferences saved').waitFor()
    await page.getByRole('button', { name: /^Dashboard/ }).click()
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

    console.log(`\n✔ e2e smoke test passed — screenshots in ${shots}`)
  } catch (err) {
    await page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => undefined)
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
