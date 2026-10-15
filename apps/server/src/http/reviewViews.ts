import { formatMoney, type getRequestDetail } from '../services/payments.js'
import { html, type SafeHtml } from './html.js'

type Detail = NonNullable<ReturnType<typeof getRequestDetail>>
const fmtTime = (iso: string | null | undefined) => (iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : '—')

function page(title: string, body: SafeHtml): string {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${title} · TradePilot</title>
<link rel="stylesheet" href="/review/assets/review.css"></head>
<body><main class="review"><div class="brandline">TradePilot · payment review</div>${body}</main></body></html>`.value
}

export function messagePage(title: string, text: string, tone: 'ok' | 'bad' | 'warn' = 'bad'): string {
  return page(title, html`<h1>${title}</h1><div class="notice ${tone}" role="status">${text}</div><p class="muted">You can close this window.</p>`)
}

export function reviewPage(
  d: Detail,
  opts: { action: 'confirm' | 'cancel'; csrf: string; token: string; expiresAt: string; error?: string | null; reason?: string; passphraseConfigured: boolean }
): string {
  const r = d.request
  const amount = formatMoney(r.amount_cents, r.currency)
  const confirm = opts.action === 'confirm'
  return page(confirm ? 'Confirm payment' : 'Cancel payment request', html`
<div class="review-head"><h1>${confirm ? 'Confirm payment' : 'Cancel payment request'} · ${r.plan_name} ${amount}</h1><span class="badge pending">pending</span></div>
<p class="sub mono">${r.id}</p>
${opts.error ? html`<div class="notice bad" role="alert">${opts.error}</div>` : ''}
${d.duplicateEvidence.length > 0 ? html`<div class="notice warn">The same screenshot file was also submitted with ${d.duplicateEvidence.length} other request(s). Check carefully.</div>` : ''}
<div class="grid">
  <div class="panel">
    <h2>Payment screenshot</h2>
    ${d.evidence
      ? html`<a class="evidence" href="/review/${opts.token}/evidence" target="_blank" rel="noopener"><img src="/review/${opts.token}/evidence" alt="Payment screenshot submitted by the client"></a>
             <p class="muted mono" style="margin:8px 0 0">${d.evidence.mime_type} · sha256 ${d.evidence.sha256.slice(0, 16)}…</p>`
      : html`<p class="muted">No screenshot on file.</p>`}
  </div>
  <div>
    <div class="panel">
      <h2>Request details</h2>
      <dl class="kv">
        <dt>Plan</dt><dd>${r.plan_name}</dd>
        <dt>Amount due</dt><dd class="mono">${amount}</dd>
        <dt>Transaction ID</dt><dd class="mono">${r.transaction_id}</dd>
        <dt>Client reference</dt><dd class="mono">${r.reference_code}</dd>
        <dt>Client email</dt><dd>${r.contact_email ?? html`<span class="muted">not provided</span>`}</dd>
        <dt>Client note</dt><dd>${r.note ?? html`<span class="muted">—</span>`}</dd>
        <dt>Submitted</dt><dd class="mono">${fmtTime(r.created_at)}</dd>
        <dt>Link expires</dt><dd class="mono">${fmtTime(opts.expiresAt)}</dd>
      </dl>
    </div>
    <div class="panel action-panel ${opts.action}">
      <h2>${confirm ? 'Activate the subscription' : 'Cancel without activating access'}</h2>
      <form class="stack" method="post" action="/review/${opts.token}">
        <input type="hidden" name="_csrf" value="${opts.csrf}">
        ${confirm
          ? html`<label class="check"><input type="checkbox" name="verified" value="yes" required>
              <span>I confirmed that <b>${amount}</b> with transaction ID <b class="mono">${r.transaction_id}</b> arrived in our account.</span></label>`
          : html`<label>Reason (sent to the client)<textarea name="reason" required minlength="3" maxlength="500" placeholder="e.g. No payment with this transaction ID was received.">${opts.reason ?? ''}</textarea></label>`}
        ${opts.passphraseConfigured
          ? html`<label>Review passphrase<input type="password" name="passphrase" autocomplete="current-password" required maxlength="1024"></label>
                 <p class="lock-note">Only the business knows the passphrase; it stops a client who sent this email from deciding their own request.</p>`
          : html`<div class="notice bad">Payment confirmation is not set up on this server (REVIEW_PASSPHRASE_HASH). No decision can be recorded until it is.</div>`}
        <div><button class="${confirm ? 'ok' : 'danger'}" type="submit">${confirm ? 'Confirm Payment' : 'Cancel Request'}</button></div>
        <p class="lock-note">${confirm ? `Activates the ${r.plan_name} plan once. ` : 'No access is granted. '}This link stops working after it is used.</p>
      </form>
    </div>
  </div>
</div>`)
}

export function resultPage(d: Detail, outcome: 'approved' | 'cancelled' | 'already_approved' | 'already_cancelled', detail: string): string {
  const r = d.request
  const title =
    outcome === 'approved' ? 'Payment confirmed' : outcome === 'cancelled' ? 'Request cancelled' : outcome === 'already_approved' ? 'Already confirmed' : 'Already cancelled'
  const tone = outcome === 'approved' || outcome === 'cancelled' ? 'ok' : 'warn'
  return page(title, html`<h1>${title}</h1><div class="notice ${tone}" role="status">${detail}</div>
<div class="panel"><dl class="kv"><dt>Request</dt><dd class="mono">${r.id}</dd><dt>Plan</dt><dd>${r.plan_name} · ${formatMoney(r.amount_cents, r.currency)}</dd><dt>Transaction ID</dt><dd class="mono">${r.transaction_id}</dd><dt>Client reference</dt><dd class="mono">${r.reference_code}</dd></dl></div>
<p class="muted">You can close this window.</p>`)
}
