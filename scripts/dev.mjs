#!/usr/bin/env node
/**
 * `npm run dev`: one command for local development.
 *  1. runs the one-time dev setup if needed (keys + .env files, never overwrites)
 *  2. starts the subscription server and waits until /healthz answers
 *  3. starts the desktop app (electron-vite dev, hot reload)
 * Ctrl+C stops both. If either exits, the other is stopped too.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const color = { server: '\x1b[36m', desktop: '\x1b[35m', dev: '\x1b[33m', reset: '\x1b[0m' }
const say = (tag, msg) => process.stdout.write(`${color[tag]}[${tag}]${color.reset} ${msg}\n`)

if (!existsSync(path.join(root, 'apps/server/.env')) || !existsSync(path.join(root, 'apps/desktop/.env'))) {
  say('dev', 'first run: creating development keys and .env files')
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/dev-setup.mjs')], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

const serverEnv = readFileSync(path.join(root, 'apps/server/.env'), 'utf8')
// PORT in the environment wins over apps/server/.env (node --env-file never overrides existing variables)
const port = Number(process.env.PORT ?? /^PORT=(\d+)/m.exec(serverEnv)?.[1] ?? 8787)
const portOverride = process.env.PORT ? { PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, TRADEPILOT_API_URL: `http://127.0.0.1:${port}` } : {}
const children = []

function run(tag, args, extraEnv = {}) {
  const env = { ...process.env, FORCE_COLOR: '1', ...extraEnv }
  // VS Code's terminal exports ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
  delete env.ELECTRON_RUN_AS_NODE
  // Own process group, so shutdown stops npm *and* everything it started (tsx watch, electron).
  const child = spawn(npm, args, { cwd: root, env, shell: process.platform === 'win32', detached: process.platform !== 'win32' })
  children.push(child)
  for (const stream of [child.stdout, child.stderr]) {
    let buf = ''
    stream.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) say(tag, line)
    })
  }
  child.on('exit', (code) => {
    say(tag, `exited (${code ?? 'signal'})`)
    shutdown(code ?? 0)
  })
  return child
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) killTree(c)
  setTimeout(() => process.exit(code), 800)
}

function killTree(child) {
  if (child.exitCode !== null || !child.pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
    else process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

function portFree(p) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(p, '127.0.0.1')
  })
}

function portOwner(p) {
  if (process.platform === 'win32') return null
  const r = spawnSync('sh', ['-c', `ss -ltnpH 'sport = :${p}' 2>/dev/null; lsof -nP -iTCP:${p} -sTCP:LISTEN 2>/dev/null | tail -n +2`], { encoding: 'utf8' })
  return r.stdout.trim() || null
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

async function waitForServer(timeoutMs = 45_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

if (!(await portFree(port))) {
  const owner = portOwner(port)
  say('dev', `port ${port} is already in use, so the TradePilot server cannot start.`)
  if (owner) say('dev', `listener: ${owner.replace(/\s+/g, ' ')}`)
  say('dev', 'This is usually a server left over from an earlier "npm run dev". Stop it (if it runs as root: sudo kill <pid>),')
  say('dev', `or set PORT=<free port> plus PUBLIC_BASE_URL and MAIN_VITE_API_BASE_URL in apps/server/.env and apps/desktop/.env.`)
  process.exit(1)
}

run('server', ['run', 'dev', '-w', '@tradepilot/server'], portOverride)
if (!(await waitForServer())) {
  say('dev', `server did not become healthy on port ${port}; stopping`)
  shutdown(1)
} else {
  say('dev', `server ready at http://127.0.0.1:${port} (admin UI: /admin). Starting the desktop app…`)
  if (!serverEnv.includes('ADMIN_')) say('dev', 'tip: create an admin with  npm run admin:create -w @tradepilot/server -- --email you@example.com --name "You"')
  run('desktop', ['run', 'dev', '-w', '@tradepilot/desktop'], portOverride)
}
