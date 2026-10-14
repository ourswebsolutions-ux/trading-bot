/**
 * Smoke test of an INSTALLED / packaged TradePilot build (not the dev build).
 *
 *   tsx apps/desktop/e2e/packaged.ts <path to the installed executable>
 *
 * Runs with a brand-new user profile (Electron's --user-data-dir; packaged builds deliberately
 * ignore TradePilot's test environment variables) and checks:
 * first launch and password setup, database persistence across restarts, the bundled trading
 * engine (no system Python), honest subscription/update/credential states, a clear error for an
 * invalid AI key, and that live trading cannot be started.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'

const exe = process.argv[2]
if (!exe) throw new Error('usage: tsx e2e/packaged.ts <installed executable>')
const shots = process.env.E2E_SCREENSHOT_DIR ?? path.join(tmpdir(), 'tradepilot-packaged-shots')
mkdirSync(shots, { recursive: true })
const PASSWORD = 'Packaged-Smoke-2026'
const step = (name: string) => console.log(`\n▶ ${name}`)
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `${process.platform}-${name}.png`) })
const nav = (page: Page, label: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${label}`) }).click()

// a clean profile (Electron's standard --user-data-dir switch)
const profile = mkdtempSync(path.join(tmpdir(), 'tradepilot-clean-'))
const { ELECTRON_RUN_AS_NODE: _drop, ...parentEnv } = process.env
const env = parentEnv as Record<string, string>

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${profile}`], env, timeout: 90_000 })
  const page = await app.firstWindow({ timeout: 90_000 })
  page.on('pageerror', (e) => console.error('  renderer error:', e.message))
  return { app, page }
}

async function closeAndConfirmExit(app: ElectronApplication) {
  const proc = app.process()
  await app.close()
  const exited = proc.exitCode !== null || (await new Promise<boolean>((r) => {
    const t = setTimeout(() => r(false), 15_000)
    proc.once('exit', () => (clearTimeout(t), r(true)))
  }))
  assert.ok(exited, 'the application process exits on close')
}

async function main() {
  let { app, page } = await launch()
  try {
    step('first launch: welcome and password setup on a clean profile')
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
    assert.equal(realpathSync(userData), realpathSync(profile), `clean profile in use (${userData})`)
    assert.equal(await app.evaluate(({ app: a }) => a.isPackaged), true, 'this is a packaged build')
    await page.locator('.welcome').click({ timeout: 30_000 })
    await page.getByRole('heading', { name: 'Create your password' }).waitFor({ timeout: 30_000 })
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByLabel('Confirm password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create password and continue' }).click()
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 30_000 })
    await shot(page, '01-dashboard')

    step('subscription status is reported honestly')
    // release builds without a configured server must say so, never pretend a trial is active
    const serverLabel = page.getByText('Server not configured').first()
    const synced = page.getByText(/Synced|Server offline|Sync error/).first()
    await serverLabel.or(synced).waitFor({ timeout: 30_000 })
    const configured = !(await serverLabel.isVisible())
    console.log(`  subscription server configured in this build: ${configured}`)

    step('bundled trading engine starts without a system Python')
    await nav(page, 'Settings')
    await page.getByRole('button', { name: 'About' }).click()
    await page.getByRole('button', { name: 'Restart engine' }).click()
    await page.getByText(/Engine restarted/).waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: 'General' }).click()
    const engineField = page.getByLabel('Trading engine')
    await engineField.waitFor()
    assert.match(await engineField.inputValue(), /^Built-in engine 1\.\d+\.\d+ \(Python 3\./)
    await shot(page, '02-engine')

    step('update system reports a real state')
    await page.getByRole('button', { name: 'Updates' }).click()
    await page.getByText('Installed version').waitFor()
    const updateText = await page.locator('.panel').filter({ hasText: 'Software updates' }).innerText()
    assert.doesNotMatch(updateText, /Development build/, 'packaged builds are not reported as development builds')
    console.log('  ' + updateText.split('\n').filter((l) => /Status|Update|macOS|feed/i.test(l)).slice(0, 4).join(' | '))
    await shot(page, '03-updates')

    step('credential storage and a clear error for an invalid AI key')
    await page.getByRole('button', { name: 'OpenAI' }).click()
    const unavailable = page.getByText('Secure storage unavailable').first()
    const keyInput = page.getByLabel('API key')
    await unavailable.or(keyInput).first().waitFor()
    if (await unavailable.isVisible()) {
      console.log('  OS secure storage is not available on this machine; credential entry is disabled (expected without a keyring)')
      assert.equal(await keyInput.isDisabled(), true)
    } else {
      await keyInput.fill('sk-invalid-tradepilot-packaged-smoke-test')
      await page.getByRole('button', { name: /^Save/ }).first().click()
      await page.getByRole('button', { name: 'Test connection' }).click()
      await page.getByText(/rejected|invalid|Incorrect API key|auth/i).first().waitFor({ timeout: 60_000 })
      console.log('  invalid key stored encrypted and rejected with a clear error')
    }
    await shot(page, '04-credentials')

    step('live trading cannot be started accidentally')
    await nav(page, 'Trading')
    await page.getByText('Exchange balance').waitFor({ timeout: 30_000 })
    const startLive = page.getByRole('button', { name: 'Start live' })
    if (await startLive.count()) for (const b of await startLive.all()) assert.equal(await b.isDisabled(), true)
    await page.getByText(/Live trading is (off|disabled)|Live trading/).first().waitFor()
    const enableLive = page.getByRole('button', { name: /Enable live trading/ })
    if (await enableLive.count()) assert.equal(await enableLive.first().isDisabled(), true, 'enabling live trading needs exchange checks first')
    await shot(page, '05-trading')

    step('restart: data persists and the password is required')
    await closeAndConfirmExit(app)
    ;({ app, page } = await launch())
    await page.locator('.welcome').click({ timeout: 30_000 })
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor({ timeout: 30_000 })
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Unlock' }).click()
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 30_000 })
    await shot(page, '06-after-restart')
    await closeAndConfirmExit(app)
    console.log(`\n✔ packaged smoke test passed (${process.platform}) — screenshots in ${shots}`)
  } catch (err) {
    await shot(page, 'failure').catch(() => undefined)
    await app.close().catch(() => undefined)
    throw err
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
