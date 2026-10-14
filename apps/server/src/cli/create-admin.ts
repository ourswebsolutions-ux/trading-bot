/**
 * Creates an administrator account.
 *   npm run admin:create -- --email you@example.com --name "Your Name" [--role superadmin|reviewer]
 * The password is read from a hidden prompt (or ADMIN_PASSWORD for automation). Never pass it as an argument.
 */
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline'
import { loadConfig } from '../config.js'
import { migrate, openDatabase } from '../db/sqlite.js'
import { createAdmin, MIN_ADMIN_PASSWORD_LENGTH, type AdminRole } from '../services/admins.js'

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })
    const original = write._writeToOutput.bind(rl)
    let prompted = false
    write._writeToOutput = (s: string) => {
      if (!prompted) {
        original(s)
        prompted = true
      } else if (s.includes('\n')) original('\n')
    }
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'superadmin' } } })
if (!values.email || !values.name) {
  console.error('Usage: npm run admin:create -- --email <email> --name "<display name>" [--role superadmin|reviewer]')
  process.exit(1)
}
const role = values.role as AdminRole
if (role !== 'superadmin' && role !== 'reviewer') {
  console.error('--role must be superadmin or reviewer')
  process.exit(1)
}

let password = process.env.ADMIN_PASSWORD
if (!password) {
  password = await promptHidden(`Password (min ${MIN_ADMIN_PASSWORD_LENGTH} chars): `)
  const confirm = await promptHidden('Confirm password: ')
  if (password !== confirm) {
    console.error('Passwords do not match')
    process.exit(1)
  }
}

const config = loadConfig()
const db = openDatabase(config.dbPath)
migrate(db)
try {
  const id = await createAdmin(db, new Date(), { email: values.email, displayName: values.name, password, role })
  console.log(`Created ${role} ${values.email} (${id})`)
} catch (err) {
  console.error(`Failed: ${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
} finally {
  db.close()
}
