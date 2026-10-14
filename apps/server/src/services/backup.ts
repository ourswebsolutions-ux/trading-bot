import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Db } from '../db/sqlite.js'

/**
 * Consistent online backup: VACUUM INTO writes a transactionally consistent copy of the
 * live database; evidence files are copied alongside. Keeps the newest `retention` sets.
 */
export function backupNow(db: Db, opts: { backupDir: string; uploadDir: string; retention: number; at?: Date }): string {
  const stamp = (opts.at ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const target = path.join(opts.backupDir, `backup-${stamp}`)
  mkdirSync(target, { recursive: true, mode: 0o700 })
  const dbFile = path.join(target, 'tradepilot.sqlite')
  db.prepare('VACUUM INTO ?').run(dbFile)
  if (existsSync(opts.uploadDir)) cpSync(opts.uploadDir, path.join(target, 'evidence'), { recursive: true })

  const sets = readdirSync(opts.backupDir).filter((n) => n.startsWith('backup-')).sort()
  for (const old of sets.slice(0, Math.max(0, sets.length - opts.retention))) {
    rmSync(path.join(opts.backupDir, old), { recursive: true, force: true })
  }
  return target
}
