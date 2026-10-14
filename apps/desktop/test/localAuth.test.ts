import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FREE_ATTEMPTS, LocalAuth, lockoutFor, MAX_LOCKOUT_MS, passwordProblem } from '../src/main/localAuth.js'
import { memoryDb } from './helpers.js'

const GOOD = 'Orbital-Kettle-42'

describe('password-only local login', () => {
  it('requires first-run setup and never ships a default password', () => {
    const auth = new LocalAuth(memoryDb())
    assert.equal(auth.status().state, 'setup_required')
  })

  it('enforces the password policy', () => {
    assert.ok(passwordProblem('short'))
    assert.ok(passwordProblem('alllowercaseletters'.slice(0, 12)))
    assert.ok(passwordProblem('password123'))
    assert.equal(passwordProblem(GOOD), null)
    assert.equal(passwordProblem('a long lowercase passphrase'), null)
  })

  it('stores a salted scrypt hash and unlocks with the right password only', async () => {
    const db = memoryDb()
    const auth = new LocalAuth(db)
    await auth.setup(GOOD, GOOD)
    const row = db.prepare('SELECT password_hash FROM local_auth').get() as { password_hash: string }
    assert.match(row.password_hash, /^scrypt\$/)
    assert.ok(!row.password_hash.includes(GOOD))
    auth.lock()
    assert.equal(auth.status().state, 'locked')
    assert.deepEqual(await auth.unlock('wrong-password-1'), { unlocked: false, lockedUntil: null, attemptsRemaining: FREE_ATTEMPTS - 1 })
    assert.deepEqual(await auth.unlock(GOOD), { unlocked: true })
    assert.equal(auth.isUnlocked(), true)
  })

  it('rejects mismatched confirmation and a second setup', async () => {
    const auth = new LocalAuth(memoryDb())
    await assert.rejects(auth.setup(GOOD, GOOD + 'x'), /do not match/)
    await auth.setup(GOOD, GOOD)
    await assert.rejects(auth.setup(GOOD, GOOD), /already set/)
  })

  it('locks out with growing delays after repeated failures, persisted across restarts', async () => {
    let now = new Date('2026-01-01T00:00:00Z')
    const db = memoryDb()
    const auth = new LocalAuth(db, () => now)
    await auth.setup(GOOD, GOOD)
    auth.lock()
    for (let i = 0; i < FREE_ATTEMPTS - 1; i++) assert.equal((await auth.unlock('nope-nope-nope')).lockedUntil, null)
    const locked = await auth.unlock('nope-nope-nope')
    assert.equal(locked.lockedUntil, new Date(now.getTime() + 30_000).toISOString())

    // a "restarted" app sees the same lockout, and even the right password is refused
    const restarted = new LocalAuth(db, () => now)
    assert.equal((await restarted.unlock(GOOD)).unlocked, false)

    now = new Date(now.getTime() + 30_001)
    const next = await restarted.unlock('still-wrong-1')
    assert.equal(next.lockedUntil, new Date(now.getTime() + 60_000).toISOString())
    assert.equal(lockoutFor(50), MAX_LOCKOUT_MS)

    now = new Date(now.getTime() + 60_001)
    assert.equal((await restarted.unlock(GOOD)).unlocked, true)
    assert.equal((db.prepare('SELECT failed_attempts FROM local_auth').get() as { failed_attempts: number }).failed_attempts, 0)
  })

  it('changes the password only with the current password', async () => {
    const auth = new LocalAuth(memoryDb())
    await auth.setup(GOOD, GOOD)
    await assert.rejects(auth.changePassword('incorrect-pass', 'New-Pass-Word-9', 'New-Pass-Word-9'), /incorrect/)
    await assert.rejects(auth.changePassword(GOOD, GOOD, GOOD), /different/)
    await auth.changePassword(GOOD, 'New-Pass-Word-9', 'New-Pass-Word-9')
    auth.lock()
    assert.equal((await auth.unlock(GOOD)).unlocked, false)
    assert.equal((await auth.unlock('New-Pass-Word-9')).unlocked, true)
  })

  it('seeds a configured initial password flagged for mandatory change', async () => {
    const auth = new LocalAuth(memoryDb())
    await assert.rejects(auth.seedInitialPassword('weak'), /rejected/)
    assert.equal(await auth.seedInitialPassword(GOOD), true)
    assert.equal(auth.status().mustChangePassword, true)
    assert.equal(await auth.seedInitialPassword('Another-Pass-1'), false)
    await auth.unlock(GOOD)
    await auth.changePassword(GOOD, 'Fresh-Secret-77', 'Fresh-Secret-77')
    assert.equal(auth.status().mustChangePassword, false)
  })

  it('locks and logs out the session', async () => {
    const auth = new LocalAuth(memoryDb())
    await auth.setup(GOOD, GOOD)
    assert.equal(auth.lock('logout').state, 'locked')
    assert.equal(auth.isUnlocked(), false)
  })
})
