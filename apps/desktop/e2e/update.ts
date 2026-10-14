/**
 * Auto-update acceptance test against a local release feed.
 *
 *   1. Package two versions (feed URL = http://127.0.0.1:47321/):
 *        TRADEPILOT_UPDATE_URL=http://127.0.0.1:47321/ TRADEPILOT_ALLOW_INSECURE_UPDATE_URL=1 \
 *          npx electron-builder --config electron-builder.config.cjs --linux AppImage -c.extraMetadata.version=0.1.0   (and 0.1.1)
 *   2. npx tsx apps/desktop/e2e/update.ts
 *
 * Installs v0.1.0 as an AppImage, serves v0.1.1 from the feed, and checks that the app
 * detects, downloads (with progress), verifies and installs the update, and that the
 * local password/data survive. Packaged builds show a real window while this runs.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'

const desktopDir = path.resolve(import.meta.dirname, '..')
const rel = (v: string) => path.join(desktopDir, 'release', v)
const shots = process.env.E2E_SCREENSHOT_DIR ?? path.join(tmpdir(), 'tradepilot-e2e-shots')
mkdirSync(shots, { recursive: true })
const PASSWORD = 'Harbor-Lantern-58'
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')
const { ELECTRON_RUN_AS_NODE: _drop, ...parentEnv } = process.env

async function launch(version: string, appImage: string, userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: path.join(rel(version), 'linux-unpacked', 'tradepilot'),
    args: [`--user-data-dir=${userData}`, '--password-store=basic'],
    env: { ...(parentEnv as Record<string, string>), APPIMAGE: appImage }
  })
  const page = await app.firstWindow()
  return { app, page }
}

async function main() {
  for (const v of ['0.1.0', '0.1.1']) assert.ok(existsSync(path.join(rel(v), 'linux-unpacked', 'tradepilot')), `release ${v} missing; see header`)

  // ---------- release feed serving v0.1.1 ----------
  const served: string[] = []
  const feed = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0]!.slice(1))
    const file = path.join(rel('0.1.1'), path.basename(name))
    served.push(`${req.method} /${name}${req.headers.range ? ` (${req.headers.range})` : ''}`)
    if (!name || !existsSync(file)) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'Content-Length': statSync(file).size })
    createReadStream(file).pipe(res)
  })
  await new Promise<void>((r) => feed.listen(47321, '127.0.0.1', r))

  const work = mkdtempSync(path.join(tmpdir(), 'tp-update-'))
  const installed = path.join(work, 'TradePilot.AppImage')
  const userData = path.join(work, 'userdata')
  copyFileSync(path.join(rel('0.1.0'), 'TradePilot-0.1.0-x86_64.AppImage'), installed)
  const before = sha(installed)
  const target = sha(path.join(rel('0.1.1'), 'TradePilot-0.1.1-x86_64.AppImage'))

  try {
    console.log('▶ launch v0.1.0, create password')
    let { app, page } = await launch('0.1.0', installed, userData)
    await page.getByRole('heading', { name: 'Create your password' }).waitFor()
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByLabel('Confirm password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create password and continue' }).click()
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor()

    console.log('▶ wait for background download of v0.1.1')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Settings/ }).click()
    await page.getByRole('button', { name: 'Updates' }).click()
    await page.getByText('Ready to install').waitFor({ timeout: 180_000 })
    await page.screenshot({ path: path.join(shots, 'update-ready.png') })
    assert.ok(served.some((s) => s.includes('latest-linux.yml')), 'feed metadata requested')
    assert.ok(served.some((s) => s.includes('TradePilot-0.1.1-x86_64.AppImage')), 'update artifact downloaded')
    console.log('  feed requests:', served.join(' | '))

    console.log('▶ restart and install')
    const exited = new Promise<void>((r) => app.process().once('exit', () => r()))
    await page.getByRole('button', { name: 'Restart and install v0.1.1' }).click()
    await exited
    // AppImageUpdater swaps the file in place; allow it a moment to finish.
    for (let i = 0; i < 60 && sha(installed) === before; i++) await new Promise((r) => setTimeout(r, 1000))
    assert.equal(sha(installed), target, 'installed AppImage replaced by the verified v0.1.1 build')
    console.log('  installed AppImage now matches v0.1.1')
    await new Promise((r) => setTimeout(r, 3000))

    console.log('▶ launch v0.1.1 with the same user data: password and data survive')
    ;({ app, page } = await launch('0.1.1', installed, userData))
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Unlock' }).click()
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor()
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Settings/ }).click()
    await page.getByRole('button', { name: 'About' }).click()
    await page.getByText('0.1.1', { exact: true }).first().waitFor()
    await page.getByRole('button', { name: 'Updates' }).click()
    await page.getByText('Up to date').waitFor({ timeout: 60_000 })
    await page.screenshot({ path: path.join(shots, 'update-after.png') })
    await app.close()
    console.log('\n✔ auto-update test passed')
  } finally {
    feed.close()
    rmSync(work, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('\n✖ auto-update test failed:', err)
  process.exit(1)
})
