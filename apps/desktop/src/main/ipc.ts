import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { AiError } from './ai/provider.js'
import { UserError } from './errors.js'
import { ProviderError } from './net.js'
import { redact } from './redact.js'
import type { Channel, IpcError, Req, Res, Result } from '../shared/ipc.js'

export interface Guard {
  /** Requires the local password session to be unlocked. Default true. */
  auth?: boolean
}

export interface IpcRegistry {
  handle<C extends Channel>(channel: C, fn: (req: Req<C>) => Promise<Res<C>> | Res<C>, guard?: Guard): void
}

/**
 * Registers handlers that (1) only answer our own renderer, (2) enforce the local login,
 * and (3) return { ok, data | error } so user-facing messages arrive intact.
 */
export function createIpcRegistry(opts: {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  isUnlocked: () => boolean
  log: (msg: string, extra?: unknown) => void
}): IpcRegistry {
  return {
    handle(channel, fn, guard = {}) {
      ipcMain.handle(channel, async (event, payload): Promise<Result<unknown>> => {
        if (!opts.isTrustedSender(event)) {
          opts.log(`blocked IPC from untrusted sender on ${channel}`)
          return { ok: false, error: { code: 'forbidden', message: 'Forbidden' } }
        }
        if (guard.auth !== false && !opts.isUnlocked()) {
          return { ok: false, error: { code: 'locked', message: 'TradePilot is locked. Enter your password to continue.' } }
        }
        try {
          const data = await fn(payload as never)
          return { ok: true, data }
        } catch (err) {
          if (err instanceof UserError) {
            const error: IpcError = { code: err.code, message: redact(err.message) }
            if (err.fields) error.fields = err.fields
            return { ok: false, error }
          }
          if (err instanceof ProviderError) return { ok: false, error: { code: `provider_${err.kind}`, message: err.message } }
          if (err instanceof AiError) return { ok: false, error: { code: `ai_${err.code}`, message: redact(err.message) } }
          opts.log(`IPC ${channel} failed`, err instanceof Error ? err.stack : err)
          return { ok: false, error: { code: 'internal', message: 'Something went wrong. The details were written to the application log.' } }
        }
      })
    }
  }
}

/** Small runtime validators for IPC payloads (the renderer is treated as untrusted input). */
export const v = {
  obj(x: unknown): Record<string, unknown> {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new UserError('bad_request', 'Invalid request')
    return x as Record<string, unknown>
  },
  str(x: unknown, max = 1000): string {
    if (typeof x !== 'string' || x.length > max) throw new UserError('bad_request', 'Invalid request')
    return x
  },
  optStr(x: unknown, max = 1000): string | undefined {
    return x === undefined || x === null ? undefined : v.str(x, max)
  },
  num(x: unknown, min: number, max: number): number {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) throw new UserError('bad_request', 'Invalid number')
    return x
  },
  oneOf<T extends string>(x: unknown, values: readonly T[]): T {
    if (typeof x !== 'string' || !values.includes(x as T)) throw new UserError('bad_request', 'Invalid option')
    return x as T
  },
  strRecord(x: unknown): Record<string, string> {
    const o = v.obj(x)
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(o)) out[v.str(k, 64)] = v.str(val, 8192)
    return out
  }
}
