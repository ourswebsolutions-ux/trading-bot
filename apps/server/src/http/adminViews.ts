import type { PaymentRequestStatus } from '@tradepilot/shared'
import type { AuditRow } from '../services/audit.js'
import type { AdminSession } from '../services/admins.js'
import { formatMoney, type AdminRequestListItem, type getRequestDetail } from '../services/payments.js'
import { html, type SafeHtml } from './html.js'

type Notice = { tone: 'ok' | 'bad' | 'warn'; text: string } | null

const fmtTime = (iso: string | null | undefined) => (iso ? iso.replace('T', ' ').slice(0, 19) + ' UTC' : '—')
const shortId = (id: string) => id.slice(0, 8)

function badge(status: string): SafeHtml {
  return html`<span class="badge ${status}">${status}</span>`
}

export function layout(title: string, session: AdminSession | null, active: string, body: SafeHtml, notice: Notice = null): string {
  const nav = session
    ? html`<nav>
        <a href="/admin" class="${active === 'requests' ? 'on' : ''}">Payment requests</a>
        ${session.admin.role === 'superadmin'
          ? html`<a href="/admin/settings" class="${active === 'settings' ? 'on' : ''}">Settings</a>
                 <a href="/admin/audit" class="${active === 'audit' ? 'on' : ''}">Audit log</a>`
          : ''}
      </nav>
      <div class="who"><span>${session.admin.email} · ${session.admin.role}</span>
        <form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${session.csrfToken}"><button class="link" type="submit">Sign out</button></form>
      </div>`
    : ''
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${title} · TradePilot Admin</title>
<link rel="stylesheet" href="/admin/assets/admin.css"></head>
<body>
${session ? html`<header class="top"><div class="brand">TradePilot <span>Admin</span></div>${nav}</header>` : ''}
<main>${notice ? html`<div class="notice ${notice.tone}" role="status">${notice.text}</div>` : ''}${body}</main>
</body></html>`.value
}

export function loginPage(csrf: string, error: string | null, next: string): string {
  return layout('Sign in', null, '', html`
<div class="login"><div class="panel">
  <h1>TradePilot Admin</h1><p class="sub">Sign in to review payment requests.</p>
  ${error ? html`<div class="notice bad" role="alert">${error}</div>` : ''}
  <form class="stack" method="post" action="/admin/login">
    <input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="next" value="${next}">
    <label>Email<input type="email" name="email" autocomplete="username" required autofocus></label>
    <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
    <button class="primary" type="submit">Sign in</button>
  </form>
</div></div>`)
}

export function requestsPage(
  session: AdminSession,
  status: PaymentRequestStatus | 'all',
  data: { items: AdminRequestListItem[]; total: number },
  counts: Record<PaymentRequestStatus, number>,
  page: number,
  pageSize: number,
  notice: Notice
): string {
  const tab = (s: string, label: string) => html`<a href="/admin?status=${s}" class="${status === s ? 'on' : ''}">${label}</a>`
  const rows = data.items.map((r) => html`<tr>
    <td class="mono">${fmtTime(r.created_at)}</td>
    <td><a class="mono" href="/admin/requests/${r.id}">${shortId(r.id)}</a></td>
    <td>${r.plan_name}</td>
    <td class="right mono">${formatMoney(r.amount_cents, r.currency)}</td>
    <td class="mono">${r.transaction_id}</td>
    <td class="mono">${r.reference_code}</td>
    <td>${badge(r.status)}</td>
    <td class="right"><a href="/admin/requests/${r.id}">${r.status === 'pending' ? 'Review' : 'View'} →</a></td>
  </tr>`)
  const pages = Math.max(1, Math.ceil(data.total / pageSize))
  return layout('Payment requests', session, 'requests', html`
<h1>Payment requests</h1><p class="sub">Confirm a payment only after you have verified the funds in your account.</p>
<div class="stats">
  <div class="stat"><span>Pending</span><b>${counts.pending}</b></div>
  <div class="stat"><span>Approved</span><b>${counts.approved}</b></div>
  <div class="stat"><span>Cancelled</span><b>${counts.cancelled}</b></div>
</div>
<div class="tabs">${tab('pending', 'Pending')}${tab('approved', 'Approved')}${tab('cancelled', 'Cancelled')}${tab('all', 'All')}</div>
<div class="panel" style="padding:0">
${data.items.length === 0
  ? html`<p class="muted" style="padding:24px;margin:0">No ${status === 'all' ? '' : status} requests.</p>`
  : html`<table><thead><tr><th>Submitted</th><th>Request</th><th>Plan</th><th class="right">Amount</th><th>Transaction ID</th><th>Device ref</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`}
</div>
${pages > 1 ? html`<div class="pager">
  ${page > 1 ? html`<a href="/admin?status=${status}&page=${page - 1}">← Newer</a>` : ''}
  <span class="muted">Page ${page} of ${pages}</span>
  ${page < pages ? html`<a href="/admin?status=${status}&page=${page + 1}">Older →</a>` : ''}
</div>` : ''}`, notice)
}

type Detail = NonNullable<ReturnType<typeof getRequestDetail>>

export function requestDetailPage(session: AdminSession, d: Detail, trial: { endsAt: string; active: boolean }, currentSub: string, notice: Notice): string {
  const r = d.request
  const amount = formatMoney(r.amount_cents, r.currency)
  const actions = r.status === 'pending'
    ? html`
<div class="panel">
  <h2>Confirm payment</h2>
  <form class="stack" method="post" action="/admin/requests/${r.id}/approve">
    <input type="hidden" name="_csrf" value="${session.csrfToken}"><input type="hidden" name="version" value="${r.version}">
    <label class="check"><input type="checkbox" name="verified" value="yes" required>
      <span>I confirmed that <b>${amount}</b> with transaction ID <b class="mono">${r.transaction_id}</b> was received.</span></label>
    <div><button class="ok" type="submit">Confirm Payment</button></div>
    <p class="muted" style="margin:0">Activates the ${r.plan_name} plan for device ${r.reference_code}. This cannot be undone from this screen.</p>
  </form>
</div>
<div class="panel">
  <h2>Cancel request</h2>
  <form class="stack" method="post" action="/admin/requests/${r.id}/cancel">
    <input type="hidden" name="_csrf" value="${session.csrfToken}"><input type="hidden" name="version" value="${r.version}">
    <label>Reason (shown to the user)<textarea name="reason" required minlength="3" maxlength="500" placeholder="e.g. No matching payment found for this transaction ID."></textarea></label>
    <div><button class="danger" type="submit">Cancel Request</button></div>
  </form>
</div>`
    : html`
<div class="panel">
  <h2>Decision</h2>
  <dl class="kv">
    <dt>Outcome</dt><dd>${badge(r.status)}</dd>
    <dt>Decided by</dt><dd>${d.decision?.admin_email ?? '—'}</dd>
    <dt>Decided at</dt><dd class="mono">${fmtTime(d.decision?.created_at)}</dd>
    ${d.decision?.reason ? html`<dt>Reason</dt><dd>${d.decision.reason}</dd>` : ''}
    ${d.subscription ? html`<dt>Activation</dt><dd class="mono">${shortId(d.subscription.id)} · ${fmtTime(d.subscription.starts_at)} → ${d.subscription.expires_at ? fmtTime(d.subscription.expires_at) : 'lifetime'}</dd>` : ''}
  </dl>
</div>`

  return layout(`Request ${shortId(r.id)}`, session, 'requests', html`
<p><a href="/admin">← All requests</a></p>
<h1>${r.plan_name} · ${amount} ${badge(r.status)}</h1>
<p class="sub mono">${r.id}</p>
${d.duplicateEvidence.length > 0 ? html`<div class="notice warn">The same screenshot file was also submitted with ${d.duplicateEvidence.length} other request(s): ${d.duplicateEvidence.map((id, i) => html`${i ? ', ' : ''}<a class="mono" href="/admin/requests/${id}">${shortId(id)}</a>`)}</div>` : ''}
<div class="grid">
  <div>
    <div class="panel">
      <h2>Payment screenshot</h2>
      ${d.evidence
        ? html`<a class="evidence" href="/admin/requests/${r.id}/evidence" target="_blank" rel="noopener"><img src="/admin/requests/${r.id}/evidence" alt="Payment screenshot submitted by the user"></a>
               <p class="muted mono" style="margin:8px 0 0">${d.evidence.mime_type} · ${(d.evidence.size_bytes / 1024).toFixed(0)} KB · sha256 ${d.evidence.sha256.slice(0, 16)}…</p>`
        : html`<p class="muted">No evidence on file.</p>`}
    </div>
  </div>
  <div>
    <div class="panel">
      <h2>Request details</h2>
      <dl class="kv">
        <dt>Plan</dt><dd>${r.plan_name}</dd>
        <dt>Amount due</dt><dd class="mono">${amount}</dd>
        <dt>Transaction ID</dt><dd class="mono">${r.transaction_id}</dd>
        <dt>Device reference</dt><dd class="mono">${r.reference_code}</dd>
        <dt>Contact email</dt><dd>${r.contact_email ?? html`<span class="muted">not provided</span>`}</dd>
        <dt>User note</dt><dd>${r.note ?? html`<span class="muted">—</span>`}</dd>
        <dt>Submitted</dt><dd class="mono">${fmtTime(r.created_at)}</dd>
        <dt>Trial</dt><dd>${trial.active ? 'active until ' : 'ended '}<span class="mono">${fmtTime(trial.endsAt)}</span></dd>
        <dt>Current access</dt><dd>${currentSub}</dd>
      </dl>
    </div>
    ${actions}
  </div>
</div>
<div class="panel"><h2>Notifications</h2>
${d.notifications.length === 0 ? html`<p class="muted">None.</p>` : html`<table><thead><tr><th>When</th><th>Channel</th><th>To</th><th>Subject</th><th>Status</th></tr></thead><tbody>
${d.notifications.map((n) => html`<tr><td class="mono">${fmtTime(n.created_at)}</td><td>${n.channel}</td><td>${n.recipient}</td><td>${n.subject}</td><td>${badge(n.status)}${n.error ? html`<div class="muted">${n.error}</div>` : ''}</td></tr>`)}
</tbody></table>`}
</div>
${d.otherRequests.length > 0 ? html`<div class="panel"><h2>Other requests from this device</h2><table><thead><tr><th>Submitted</th><th>Request</th><th>Plan</th><th>Transaction ID</th><th>Status</th></tr></thead><tbody>
${d.otherRequests.map((o) => html`<tr><td class="mono">${fmtTime(o.created_at)}</td><td><a class="mono" href="/admin/requests/${o.id}">${shortId(o.id)}</a></td><td>${o.plan_code}</td><td class="mono">${o.transaction_id}</td><td>${badge(o.status)}</td></tr>`)}
</tbody></table></div>` : ''}`, notice)
}

export function settingsPage(
  session: AdminSession,
  values: { notifyEmail: string; paymentInstructions: string },
  smtp: { configured: boolean; description: string },
  notice: Notice,
  errors: Record<string, string> = {}
): string {
  return layout('Settings', session, 'settings', html`
<h1>Settings</h1><p class="sub">Notification routing, payment instructions and email delivery.</p>
<div class="panel">
  <h2>Payment & notifications</h2>
  <form class="stack" method="post" action="/admin/settings">
    <input type="hidden" name="_csrf" value="${session.csrfToken}">
    <label>Administrator notification email
      <input type="email" name="notifyEmail" value="${values.notifyEmail}" required>
      ${errors.notifyEmail ? html`<span class="muted" style="color:var(--bad)">${errors.notifyEmail}</span>` : ''}</label>
    <label>Payment instructions shown in the app
      <textarea name="paymentInstructions" rows="8" maxlength="4000" required placeholder="Bank / wallet details, accepted methods, and what to put in the payment memo.">${values.paymentInstructions}</textarea>
      ${errors.paymentInstructions ? html`<span class="muted" style="color:var(--bad)">${errors.paymentInstructions}</span>` : ''}
      <span class="muted" style="font-weight:400">Each user also sees their device reference code (e.g. TP-7KQ4-M9XD) and is asked to include it in the payment memo.</span></label>
    <div><button class="primary" type="submit">Save settings</button></div>
  </form>
</div>
<div class="panel">
  <h2>SMTP delivery</h2>
  <dl class="kv" style="margin-bottom:16px"><dt>Status</dt><dd>${smtp.configured ? html`<span class="badge approved">configured</span>` : html`<span class="badge failed">not configured</span>`}</dd><dt>Transport</dt><dd class="mono">${smtp.description}</dd></dl>
  <p class="muted">SMTP host, port, TLS mode and credentials come from server environment variables / secret files and are never shown here.</p>
  <form class="stack" method="post" action="/admin/settings/test-email" style="max-width:420px">
    <input type="hidden" name="_csrf" value="${session.csrfToken}">
    <label>Send a test email to<input type="email" name="to" value="${values.notifyEmail}" required></label>
    <div><button type="submit" ${smtp.configured ? '' : 'disabled'}>Send test email</button></div>
  </form>
</div>`, notice)
}

export function auditPage(session: AdminSession, rows: AuditRow[], page: number): string {
  return layout('Audit log', session, 'audit', html`
<h1>Audit log</h1><p class="sub">Append-only record of approvals, cancellations, sign-ins and subscription changes.</p>
<div class="panel" style="padding:0"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th></tr></thead><tbody>
${rows.map((r) => html`<tr><td class="mono">${fmtTime(r.occurred_at)}</td><td>${r.actor_label ?? r.actor_type}${r.actor_id && !r.actor_label ? html` <span class="mono muted">${shortId(r.actor_id)}</span>` : ''}</td>
<td class="mono">${r.action}</td><td>${r.entity_type ? html`${r.entity_type} ${r.entity_type === 'payment_request' ? html`<a class="mono" href="/admin/requests/${r.entity_id ?? ''}">${shortId(r.entity_id ?? '')}</a>` : html`<span class="mono">${shortId(r.entity_id ?? '')}</span>`}` : '—'}</td>
<td class="mono muted" style="max-width:320px">${r.details ?? ''}</td><td class="mono muted">${r.ip ?? ''}</td></tr>`)}
</tbody></table></div>
<div class="pager">${page > 1 ? html`<a href="/admin/audit?page=${page - 1}">← Newer</a>` : ''}${rows.length === 100 ? html`<a href="/admin/audit?page=${page + 1}">Older →</a>` : ''}</div>`)
}

export function messagePage(session: AdminSession | null, title: string, text: string, status: 'bad' | 'warn' = 'bad'): string {
  return layout(title, session, '', html`<h1>${title}</h1><div class="notice ${status}">${text}</div><p><a href="/admin">← Back to requests</a></p>`)
}
