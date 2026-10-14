import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Stable per-machine identifier (survives app reinstall and deletion of app data) used
 * to bind the server-side trial to this computer. Only a salted SHA-256 leaves the device.
 */
async function rawMachineId(): Promise<string> {
  switch (process.platform) {
    case 'win32': {
      const { stdout } = await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true })
      const m = /MachineGuid\s+REG_SZ\s+([\w-]+)/i.exec(stdout)
      if (m?.[1]) return m[1]
      break
    }
    case 'darwin': {
      const { stdout } = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)
      if (m?.[1]) return m[1]
      break
    }
    default:
      for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const id = (await readFile(file, 'utf8')).trim()
          if (id) return id
        } catch {
          // try next
        }
      }
  }
  throw new Error('Could not determine a machine identifier for trial registration')
}

let cached: Promise<string> | null = null
export function machineFingerprint(): Promise<string> {
  cached ??= rawMachineId().then((id) => createHash('sha256').update(`tradepilot:v1:${id.toLowerCase()}`).digest('hex'))
  return cached
}
