// Builds the self-contained trading engine executable (PyInstaller, one-folder mode) into
// engine/dist/tradepilot-engine so installers do not need Python on the user's machine.
// Usage: node scripts/build-engine.mjs [python]   (python defaults to $PYTHON or python3/python)
// Requires: pip install -r engine/requirements-build.txt
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const engineDir = path.join(root, 'engine')
const python = process.argv[2] ?? process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const out = path.join(engineDir, 'dist')
rmSync(path.join(out, 'tradepilot-engine'), { recursive: true, force: true })

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
