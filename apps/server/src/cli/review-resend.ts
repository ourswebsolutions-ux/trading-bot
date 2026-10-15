/**
 * Prints a fresh Confirm/Cancel link pair for a pending request (e.g. after the links expired).
 *   npm run review:resend -w @tradepilot/server -- <request id>
 * Earlier unused links for that request stop working.
 */
import { createContext } from '../bootstrap.js'
import { loadConfig } from '../config.js'
import { formatMoney, getRequestDetail } from '../services/payments.js'
import { issueReviewLinks } from '../services/reviewLinks.js'

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
const links = issueReviewLinks(ctx, id)
// The server does not send email itself (the client's app does); print the fresh links so the
// business can use them. Earlier links for this request no longer work.
console.log(`New review links for ${id} (${d.request.plan_name} ${formatMoney(d.request.amount_cents, d.request.currency)}, transaction ${d.request.transaction_id}, client ${d.request.reference_code}):`)
console.log(`  Confirm Payment:  ${links.confirmUrl}`)
console.log(`  Cancel Request:   ${links.cancelUrl}`)
console.log(`They work once, require the review passphrase, and expire on ${links.expiresAt.slice(0, 16).replace('T', ' ')} UTC.`)
ctx.db.close()
