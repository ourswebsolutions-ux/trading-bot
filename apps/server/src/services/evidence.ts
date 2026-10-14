import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Private on-disk storage for payment screenshots. Files live outside any static
 * web root under random names and are only served through the authenticated admin route.
 */
export class EvidenceStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(dir, 0o700)
    } catch {
      // best effort on filesystems without POSIX modes
    }
  }

  private resolve(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error('Invalid evidence storage key')
    return path.join(this.dir, key)
  }

  async save(bytes: Buffer): Promise<string> {
    const key = randomUUID()
    await writeFile(this.resolve(key), bytes, { mode: 0o600, flag: 'wx' })
    return key
  }

  read(key: string): Promise<Buffer> {
    return readFile(this.resolve(key))
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true })
  }
}
