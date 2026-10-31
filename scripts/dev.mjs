#!/usr/bin/env node
/**
 * `npm run dev`: starts the desktop app for local development (electron-vite dev, hot reload).
 * Ctrl+C stops it.
 */
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const env = { ...process.env, FORCE_COLOR: '1' }
// VS Code's terminal exports ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
delete env.ELECTRON_RUN_AS_NODE
// Own process group, so shutdown stops npm *and* everything it started (electron-vite, electron).
const child = spawn(npm, ['run', 'dev', '-w', '@tradepilot/desktop'], { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32', detached: process.platform !== 'win32' })

function shutdown(code) {
  if (child.exitCode === null && child.pid) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
      else process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  setTimeout(() => process.exit(code), 500)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
child.on('exit', (code) => process.exit(code ?? 0))
