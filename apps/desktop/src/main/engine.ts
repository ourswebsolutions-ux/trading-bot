import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { UserError } from './errors.js'
import type { EngineStatus } from '../shared/ipc.js'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/** Spawns the Python engine and speaks JSON-lines RPC over stdio. */
export class EngineBridge {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private status: EngineStatus = { state: 'stopped', message: null, engineVersion: null, python: null, liveTradingEnabled: false }
  private starting: Promise<void> | null = null
  private stderrTail = ''

  constructor(
    private readonly engineDir: string,
    private readonly pythonPath: () => string,
    private readonly onChange: (s: EngineStatus) => void = () => {}
  ) {}

  getStatus(): EngineStatus {
    return this.status
  }

  private set(s: Partial<EngineStatus>) {
    this.status = { ...this.status, ...s, liveTradingEnabled: false }
    this.onChange(this.status)
  }

  async start(): Promise<EngineStatus> {
    if (this.status.state === 'ready' && this.child) return this.status
    this.starting ??= this.spawnEngine().finally(() => (this.starting = null))
    await this.starting
    return this.status
  }

  private async spawnEngine(): Promise<void> {
    const entry = path.join(this.engineDir, 'run_engine.py')
    if (!existsSync(entry)) {
      this.set({ state: 'error', message: `Engine files not found in ${this.engineDir}` })
      return
    }
    this.set({ state: 'starting', message: null })
    this.stderrTail = ''
    const python = this.pythonPath()
    // -E: ignore PYTHON* env vars, -s: no user site-packages, -u: unbuffered stdio
    const child = spawn(python, ['-E', '-s', '-u', entry], {
      cwd: this.engineDir,
      env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true
    })
    this.child = child
    child.stderr.on('data', (d: Buffer) => (this.stderrTail = (this.stderrTail + d.toString()).slice(-2000)))
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line))
    const failAll = (message: string) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new UserError('engine_unavailable', message))
      }
      this.pending.clear()
    }
    child.on('error', (err) => {
      this.child = null
      const msg = (err as NodeJS.ErrnoException).code === 'ENOENT' ? `Python was not found ("${python}"). Install Python 3.10+ or set its path in Settings → General.` : err.message
      this.set({ state: 'error', message: msg })
      failAll(msg)
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      const msg = `Engine exited (code ${code ?? 'signal'})${this.stderrTail ? `: ${this.stderrTail.trim().split('\n').at(-1)}` : ''}`
      this.set({ state: code === 0 ? 'stopped' : 'error', message: code === 0 ? null : msg })
      failAll(msg)
    })
    try {
      const health = (await this.call('health', {}, 10_000)) as { engineVersion: string; python: string; liveTradingEnabled: boolean }
      if (health.liveTradingEnabled) throw new Error('Engine reported live trading enabled; refusing to run.')
      this.set({ state: 'ready', message: null, engineVersion: health.engineVersion, python: health.python })
    } catch (err) {
      if (this.status.state !== 'error') this.set({ state: 'error', message: err instanceof Error ? err.message : String(err) })
      this.stop()
    }
  }

  private onLine(line: string) {
    let msg: { id?: number; result?: unknown; error?: { code: string; message: string; data?: Record<string, string> } }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined
    if (!p) return
    this.pending.delete(msg.id!)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new UserError(msg.error.code, msg.error.message, msg.error.data ?? undefined))
    else p.resolve(msg.result)
  }

  private call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new UserError('engine_unavailable', this.status.message ?? 'Trading engine is not running.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new UserError('engine_timeout', `Engine did not respond to ${method} within ${timeoutMs / 1000}s.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  async request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    await this.start()
    if (this.status.state !== 'ready') throw new UserError('engine_unavailable', this.status.message ?? 'Trading engine failed to start.')
    return (await this.call(method, params, timeoutMs)) as T
  }

  stop(): void {
    const child = this.child
    this.child = null
    child?.kill()
    if (this.status.state !== 'error') this.set({ state: 'stopped' })
  }

  async restart(): Promise<EngineStatus> {
    this.stop()
    this.set({ state: 'stopped', message: null })
    return this.start()
  }
}
