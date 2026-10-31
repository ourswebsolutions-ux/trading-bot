// Builds the self-contained trading engine executable (PyInstaller, one-folder mode) into
// engine/dist/tradepilot-engine so installers do not need Python on the user's machine.
// Usage: node scripts/build-engine.mjs [python] [--mt5]   (python defaults to $PYTHON or python3/python)
// Requires: pip install -r engine/requirements-build.txt
// --mt5 (Windows only) also builds the MetaTrader 5 bridge into engine/dist/tradepilot-mt5-bridge;
// requires: pip install -r engine/requirements-mt5.txt
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const engineDir = path.join(root, 'engine')
const args = process.argv.slice(2)
const withMt5 = args.includes('--mt5')
const python = args.find((a) => !a.startsWith('--')) ?? process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
if (withMt5 && process.platform !== 'win32') {
  console.error('--mt5: the MetaTrader5 package only exists for Windows; build the bridge on Windows.')
  process.exit(1)
}
const out = path.join(engineDir, 'dist')
rmSync(path.join(out, 'tradepilot-engine'), { recursive: true, force: true })
rmSync(path.join(out, 'tradepilot-mt5-bridge'), { recursive: true, force: true })

const run = (args, opts = {}) => {
  const r = spawnSync(python, args, { stdio: 'inherit', cwd: engineDir, ...opts })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
run([
  '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--console',
  '--name', 'tradepilot-engine',
  '--distpath', out,
  '--workpath', path.join(engineDir, 'build'),
  '--specpath', path.join(engineDir, 'build'),
  '--paths', engineDir,
  path.join(engineDir, 'run_engine.py')
])

const exe = path.join(out, 'tradepilot-engine', process.platform === 'win32' ? 'tradepilot-engine.exe' : 'tradepilot-engine')
if (!existsSync(exe)) {
  console.error(`engine executable not produced: ${exe}`)
  process.exit(1)
}
// smoke test: one health request over the JSON-lines protocol
const r = spawnSync(exe, [], { input: '{"id":1,"method":"health","params":{}}\n', encoding: 'utf8', timeout: 60_000 })
const line = (r.stdout ?? '').split('\n').find((l) => l.includes('"id": 1') || l.includes('"id":1'))
const health = line ? JSON.parse(line) : null
if (!health?.result?.engineVersion || health.result.liveTradingEnabled !== false) {
  console.error('bundled engine failed its health check', r.status, r.stdout, r.stderr)
  process.exit(1)
}
console.log(`bundled engine OK: ${exe} (engine ${health.result.engineVersion}, Python ${health.result.python})`)

if (withMt5) {
  run([
    '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--console',
    '--name', 'tradepilot-mt5-bridge',
    '--distpath', out,
    '--workpath', path.join(engineDir, 'build'),
    '--specpath', path.join(engineDir, 'build'),
    '--paths', engineDir,
    '--hidden-import', 'MetaTrader5',
    path.join(engineDir, 'run_mt5_bridge.py')
  ])
  const bridge = path.join(out, 'tradepilot-mt5-bridge', 'tradepilot-mt5-bridge.exe')
  if (!existsSync(bridge)) {
    console.error(`MT5 bridge executable not produced: ${bridge}`)
    process.exit(1)
  }
  // smoke test: the bundled bridge must load the MetaTrader5 package (no terminal or login needed)
  const b = spawnSync(bridge, [], { input: '{"id":1,"method":"health","params":{}}\n', encoding: 'utf8', timeout: 60_000 })
  const bl = (b.stdout ?? '').split('\n').find((l) => l.includes('"id": 1') || l.includes('"id":1'))
  const bh = bl ? JSON.parse(bl) : null
  if (bh?.result?.package !== 'MetaTrader5' || bh.result.unavailable) {
    console.error('bundled MT5 bridge failed its health check', b.status, b.stdout, b.stderr)
    process.exit(1)
  }
  console.log(`bundled MT5 bridge OK: ${bridge} (MetaTrader5 ${bh.result.packageVersion ?? 'version unknown'})`)
}
