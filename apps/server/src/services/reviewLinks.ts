import type { AppContext } from '../context.js'
import { newId, randomToken, sha256Hex } from '../security/tokens.js'
import { recordAudit } from './audit.js'

export interface ReviewLinks {
  confirmUrl: string
  cancelUrl: string
  expiresAt: string
}

export interface ReviewTokenRow {
  id: string
  request_id: string
  action: 'confirm' | 'cancel'
  created_at: string
  expires_at: string
  used_at: string | null
  revoked_at: string | null
}

export type TokenProblem = 'invalid' | 'expired' | 'used' | 'revoked'

/**
 * Issues a fresh Confirm/Cancel link pair for a pending request and revokes any earlier
 * unused pair. Tokens are 256-bit random values; only their hashes are stored.
 */
export function issueReviewLinks(ctx: AppContext, requestId: string): ReviewLinks {
  const now = ctx.clock.now()
  const iso = now.toISOString()
  const expiresAt = new Date(now.getTime() + ctx.config.reviewLinkTtlMs).toISOString()
  ctx.db.prepare('UPDATE review_tokens SET revoked_at = ? WHERE request_id = ? AND used_at IS NULL AND revoked_at IS NULL').run(iso, requestId)
  const urls: Record<'confirm' | 'cancel', string> = { confirm: '', cancel: '' }
  for (const action of ['confirm', 'cancel'] as const) {
    const token = randomToken(32)
    ctx.db.prepare('INSERT INTO review_tokens (id, request_id, action, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId(), requestId, action, sha256Hex(token), iso, expiresAt)
    urls[action] = `${ctx.config.publicBaseUrl}/review/${token}`
  }
  recordAudit(ctx.db, now, { actorType: 'system', action: 'review_links.issued', entityType: 'payment_request', entityId: requestId, details: { expiresAt } })
  return { confirmUrl: urls.confirm, cancelUrl: urls.cancel, expiresAt }
}

export function resolveReviewToken(ctx: AppContext, token: string): { row: ReviewTokenRow } | { problem: TokenProblem; row?: ReviewTokenRow } {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return { problem: 'invalid' }
  const row = ctx.db.prepare('SELECT id, request_id, action, created_at, expires_at, used_at, revoked_at FROM review_tokens WHERE token_hash = ?').get(sha256Hex(token)) as
    | ReviewTokenRow
    | undefined
  if (!row) return { problem: 'invalid' }
  if (row.used_at) return { problem: 'used', row }
  if (row.revoked_at) return { problem: 'revoked', row }
  if (row.expires_at <= ctx.clock.now().toISOString()) return { problem: 'expired', row }
  return { row }
}

/** Marks the whole pair as used: a request can be decided through its links only once. */
export function consumeReviewTokens(ctx: AppContext, requestId: string): void {
  const iso = ctx.clock.now().toISOString()
  ctx.db.prepare('UPDATE review_tokens SET used_at = ? WHERE request_id = ? AND used_at IS NULL').run(iso, requestId)
}

/** Atomically claims a link: only one caller can ever win, even with simultaneous clicks. */
export function claimReviewToken(ctx: AppContext, tokenId: string): boolean {
  const res = ctx.db.prepare('UPDATE review_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
    .run(ctx.clock.now().toISOString(), tokenId, ctx.clock.now().toISOString())
  return res.changes === 1
}
