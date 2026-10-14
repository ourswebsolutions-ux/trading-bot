/**
 * Emails a fresh Confirm/Cancel link pair for a pending request (e.g. after the links expired).
 *   npm run review:resend -w @tradepilot/server -- <request id>
 * Earlier unused links for that request stop working.
 */
import { createContext } from '../bootstrap.js'
import { loadConfig } from '../config.js'
import { formatMoney, getRequestDetail } from '../services/payments.js'
import { issueReviewLinks } from '../services/reviewLinks.js'
import { getSetting } from '../services/settings.js'

const id = process.argv[2]
if (!id) {
  console.error('Usage: npm run review:resend -w @tradepilot/server -- <request id>')
  process.exit(1)
}
const ctx = createContext(loadConfig())
const d = getRequestDetail(ctx, id)
if (!d) {
  console.error(`No payment request ${id}`)
  process.exit(1)
}
if (d.request.status !== 'pending') {
  console.error(`Request ${id} is already ${d.request.status}; no links issued.`)
  process.exit(1)
}
const to = getSetting(ctx.db, 'admin_notify_email')
const links = issueReviewLinks(ctx, id)
const outcome = await ctx.notifier.email({
  kind: 'admin_review_links_reissued',
  to,
  subject: `[TradePilot] New review links — ${d.request.plan_name} ${formatMoney(d.request.amount_cents, d.request.currency)} — ${d.request.reference_code}`,
  body: [`New links for payment request ${id} (transaction ${d.request.transaction_id}).`, '', `  Confirm Payment:  ${links.confirmUrl}`, `  Cancel Request:   ${links.cancelUrl}`, '', `They work once and expire on ${links.expiresAt.slice(0, 16).replace('T', ' ')} UTC. Earlier links no longer work.`].join('\n'),
  requestId: id,
  deviceId: d.request.device_id
})
console.log(`Review links for ${id}: email ${outcome}${outcome !== 'sent' ? ' — check SMTP settings and ADMIN_NOTIFY_EMAIL' : ` to ${to}`}.`)
ctx.db.close()
process.exit(outcome === 'sent' ? 0 : 1)
