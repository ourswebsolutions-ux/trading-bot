import { useState } from 'react'
import type { PaymentRequestDto } from '@tradepilot/shared'
import { TRIAL_DURATION_MS, isValidEmail, isValidTransactionId } from '@tradepilot/shared'
import type { PlansView, ScreenshotSelection } from '@shared/ipc'
import { Icon } from '../components/icons'
import { Badge, Banner, Button, ConfirmDialog, Empty, ErrorState, Field, Panel, Progress, Skeleton, useToast } from '../components/ui'
import { call, errorMessage, fieldErrors } from '../lib/api'
import { ago, bytes, cents, date, dateTime, duration } from '../lib/format'
import { useNow, useResource } from '../lib/hooks'
import { serverNow, useApp } from '../lib/state'

function StatusCard() {
  const { subscription, refreshSubscription } = useApp()
  const toast = useToast()
  const [refreshing, setRefreshing] = useState(false)
  const now = useNow(1000)
  const s = subscription?.status
  const refresh = async () => {
    setRefreshing(true)
    try {
      const v = await refreshSubscription()
      if (v?.syncError) toast({ tone: 'bad', title: 'Could not reach the server', body: v.syncError })
      else toast({ tone: 'ok', title: 'Status updated' })
    } catch (err) {
      toast({ tone: 'bad', title: 'Refresh failed', body: errorMessage(err) })
    } finally {
      setRefreshing(false)
    }
  }

  if (!subscription) return <Panel title="Your access"><Skeleton height={80} /></Panel>
  if (!subscription.configured) {
    return <Panel title="Your access"><Banner tone="warn" title="Subscription server not configured">{subscription.configurationError}</Banner></Panel>
  }

  const trialLeft = s ? Date.parse(s.trial.endsAt) - serverNow(subscription, now) : 0
  const sub = s?.subscription
  return (
    <Panel title="Your access" actions={<><span className="faint" style={{ fontSize: 12 }}>Synced {ago(subscription.lastSyncedAt, now)}</span><Button size="sm" icon="refresh" onClick={refresh} loading={refreshing}>Refresh</Button></>}>
      {subscription.syncError && <div style={{ marginBottom: 14 }}><Banner tone={s ? 'warn' : 'bad'} title={s ? 'Showing the last verified status' : 'Status unavailable'}>{subscription.syncError}</Banner></div>}
      {!s ? <Empty icon="server" title="Waiting for the server">Your trial starts the first time TradePilot reaches the subscription server.</Empty> : (
        <div className="grid cols-3" style={{ alignItems: 'start' }}>
          <div style={{ display: 'grid', gap: 8 }}>
            <span className="faint" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Status</span>
            {sub?.status === 'active' ? (
              <>
                <div className="countdown">{sub.planCode === 'lifetime' ? 'Lifetime' : 'Monthly'}</div>
                <div><Badge tone="ok"><Icon name="check" size={11} /> Active</Badge></div>
              </>
            ) : s.trial.active ? (
              <>
                <div className="countdown">{duration(Math.max(0, trialLeft))}</div>
                <div className="muted">Free trial remaining</div>
                <Progress value={(Math.max(0, trialLeft) / TRIAL_DURATION_MS) * 100} />
              </>
            ) : (
              <>
                <div className="countdown" style={{ color: 'var(--down)' }}>{s.access.reason === 'subscription_expired' ? 'Expired' : 'Trial ended'}</div>
                <div className="muted">Paid features are paused. Choose a plan below.</div>
              </>
            )}
          </div>
          <dl className="kv" style={{ gridTemplateColumns: '130px 1fr' }}>
            <dt>Trial started</dt><dd>{dateTime(s.trial.startedAt)}</dd>
            <dt>Trial ends</dt><dd>{dateTime(s.trial.endsAt)}</dd>
            {sub && <><dt>Plan activated</dt><dd>{dateTime(sub.activatedAt)}</dd></>}
            {sub && <><dt>{sub.status === 'active' ? 'Expires' : 'Expired'}</dt><dd>{sub.expiresAt ? dateTime(sub.expiresAt) : 'Never (lifetime)'}</dd></>}
          </dl>
          <dl className="kv" style={{ gridTemplateColumns: '130px 1fr' }}>
            <dt>Reference code</dt>
            <dd style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="mono">{s.referenceCode}</span>
              <button className="icon-btn" style={{ width: 24, height: 24 }} aria-label="Copy reference code" onClick={() => void navigator.clipboard.writeText(s.referenceCode).then(() => toast({ tone: 'ok', title: 'Reference code copied' }))}><Icon name="copy" size={13} /></button>
            </dd>
            <dt>Verified by</dt><dd>{subscription.access.source === 'server' ? 'Server (live)' : subscription.access.source === 'offline_token' ? 'Signed offline status' : '—'}</dd>
            <dt>Paid features</dt><dd>{subscription.access.allowed ? <Badge tone="ok">Enabled</Badge> : <Badge tone="warn">Paused</Badge>}</dd>
          </dl>
        </div>
      )}
    </Panel>
  )
}

/** Why payment requests can't be sent yet, with the exact fix (server setup is shown as steps, not as an error). */
function PaymentsUnavailable({ payments, onRetry }: { payments: PlansView['payments']; onRetry?: () => void }) {
  if (payments.available) return null
  const retry = onRetry ? <Button size="sm" icon="refresh" onClick={onRetry}>Check again</Button> : undefined
  if (payments.problemCode === 'review_passphrase_missing') {
    return (
      <Banner tone="warn" icon="lock" title="Payments need a one-time setup on the subscription server" actions={retry}>
        <div style={{ display: 'grid', gap: 6 }}>
          <span>{payments.problem}</span>
          <span><b>For the server operator:</b></span>
          <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
            <li>On the server, run <code className="mono selectable">{payments.setupCommand}</code> and choose the review passphrase (12+ characters). Only its hash is saved, in <span className="mono">apps/server/.env</span>.</li>
            <li>Restart the subscription server, then choose <b>Check again</b> here.</li>
            <li>Keep the passphrase private: it is entered on the Confirm Payment / Cancel Request page that opens from the emailed links.</li>
          </ol>
        </div>
      </Banner>
    )
  }
  return <Banner tone="bad" title="Payment requests are unavailable" actions={retry}>{payments.problem}</Banner>
}

function PaymentForm({ plans, planCode, onCancel, onSubmitted }: { plans: PlansView; planCode: string; onCancel: () => void; onSubmitted: () => void }) {
  const toast = useToast()
  const { navigate } = useApp()
  const plan = plans.plans.find((p) => p.code === planCode)!
  const [txn, setTxn] = useState('')
  const [email, setEmail] = useState(plans.clientEmail.address ?? '')
  const [note, setNote] = useState('')
  const [shot, setShot] = useState<ScreenshotSelection | null>(null)
  const [picking, setPicking] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const pick = async () => {
    setPicking(true)
    setErrors((e) => ({ ...e, screenshot: '' }))
    try {
      const s = await call('subscription:pickScreenshot')
      if (s) setShot(s)
    } catch (err) {
      setErrors((e) => ({ ...e, screenshot: errorMessage(err) }))
    } finally {
      setPicking(false)
    }
  }

  const validate = () => {
    const e: Record<string, string> = {}
    if (!isValidTransactionId(txn)) e.transactionId = 'Enter the transaction ID from your payment receipt (6–64 letters, digits or - _ . / #).'
    if (!shot) e.screenshot = 'Attach a screenshot of the completed payment.'
    if (!isValidEmail(email.trim())) e.contactEmail = 'Enter your email address.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const submit = async () => {
    setError(null)
    try {
      const created = await call('subscription:submit', { planCode, transactionId: txn, contactEmail: email || undefined, note: note || undefined, screenshotId: shot!.id })
      toast({ tone: 'ok', title: 'Payment request sent', body: `Request ${created.id.slice(0, 8)} was emailed to ${plans.payments.businessEmail} for confirmation. You will be notified when it is processed.` })
      onSubmitted()
    } catch (err) {
      setError(errorMessage(err))
      setErrors(fieldErrors(err))
      throw err
    }
  }

  return (
    <Panel title={`Pay for ${plan.name} · ${cents(plan.priceCents, plan.currency)}`} actions={<Button size="sm" variant="ghost" onClick={onCancel}>Change plan</Button>}>
      <div className="grid cols-2" style={{ alignItems: 'start', gap: 24 }}>
        <div style={{ display: 'grid', gap: 14 }}>
          <div className="panel-title">1 · Make the payment</div>
          <PaymentsUnavailable payments={plans.payments} />
          {plans.payments.available && !plans.clientEmail.configured && (
            <Banner tone="warn" title="Configure your email connection first" actions={<Button size="sm" onClick={() => navigate('settings', { tab: 'smtp' })}>Open SMTP settings</Button>}>
              {plans.clientEmail.problem}
            </Banner>
          )}
          <dl className="kv" style={{ gridTemplateColumns: '150px 1fr' }}>
            <dt>Amount</dt><dd className="mono" style={{ fontSize: 15 }}>{cents(plan.priceCents, plan.currency)} {plan.currency}</dd>
            <dt>Payment reference</dt><dd><span className="ref-code">{plans.referenceCode}</span><div className="faint" style={{ fontSize: 12 }}>Include this in the payment memo so your payment can be matched.</div></dd>
          </dl>
          <ol className="pay-steps">
            <li>
              Pay <b>{cents(plan.priceCents, plan.currency)}</b> for the {plan.name} plan{plan.billing === 'monthly' ? ' (one month of access)' : ' (one-time payment)'}.
              {plans.paymentInstructions ? (
                <div className="instructions" style={{ marginTop: 6 }}>{plans.paymentInstructions}</div>
              ) : (
                <> For payment details, email <span className="selectable mono">{plans.payments.businessEmail}</span> and quote your payment reference.</>
              )}
            </li>
            <li>Write your payment reference <span className="mono">{plans.referenceCode}</span> in the payment memo or description.</li>
            <li>Keep the transaction ID from your receipt and take a screenshot of the completed payment.</li>
            <li>
              Submit both on the right. TradePilot emails your email address, plan, transaction ID and screenshot to <span className="selectable mono">{plans.payments.businessEmail}</span> from
              your own email account (Settings → SMTP Email). Once the payment is verified it is confirmed there and your plan activates automatically; you are notified in TradePilot.
            </li>
          </ol>
        </div>
        <form className="form" onSubmit={(e) => { e.preventDefault(); if (validate()) setConfirming(true) }}>
          <div className="panel-title">2 · Submit proof of payment</div>
          {error && <Banner tone="bad">{error}</Banner>}
          <Field label="Transaction ID" error={errors.transactionId} hint="Exactly as shown on your bank / wallet receipt">
            <input className={`input mono ${errors.transactionId ? 'invalid' : ''}`} value={txn} maxLength={64} onChange={(e) => setTxn(e.target.value)} placeholder="e.g. 4B7K-99Q2-XX81" />
          </Field>
          <Field group label="Payment screenshot" error={errors.screenshot} hint="PNG, JPEG or WebP, up to 5 MB">
            {shot ? (
              <div className="shot-preview">
                <img src={shot.previewDataUrl} alt="Selected payment screenshot" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shot.name}</div>
                  <div className="faint">{shot.mime.replace('image/', '').toUpperCase()} · {bytes(shot.sizeBytes)}</div>
                </div>
                <Button size="sm" onClick={pick} loading={picking}>Replace</Button>
              </div>
            ) : (
              <Button icon="upload" onClick={pick} loading={picking}>Choose screenshot…</Button>
            )}
          </Field>
          <Field label="Your email address" error={errors.contactEmail} hint={plans.clientEmail.address ? 'From your SMTP settings; included in the request so you can be contacted.' : 'Included in the request so you can be contacted.'}>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Note (optional)" error={errors.note}>
            <textarea className="textarea" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="btn-row">
            <Button type="submit" variant="primary" disabled={!plans.payments.available || !plans.clientEmail.configured}>Submit for review</Button>
            <span className="faint" style={{ fontSize: 12 }}>Uploading a screenshot does not activate access; it activates when the payment is confirmed.</span>
          </div>
        </form>
      </div>
      {confirming && (
        <ConfirmDialog title="Submit payment request?" confirmLabel="Submit request" onClose={() => setConfirming(false)} onConfirm={submit}>
          <dl className="kv" style={{ gridTemplateColumns: '130px 1fr', color: 'var(--text)' }}>
            <dt>Plan</dt><dd>{plan.name}</dd>
            <dt>Amount</dt><dd className="mono">{cents(plan.priceCents, plan.currency)}</dd>
            <dt>Transaction ID</dt><dd className="mono">{txn.trim().toUpperCase()}</dd>
            <dt>Your email</dt><dd>{email.trim()}</dd>
            <dt>Screenshot</dt><dd>{shot?.name}</dd>
          </dl>
          <span>TradePilot emails this request from {plans.clientEmail.address ?? 'your email account'} to {plans.payments.businessEmail} for confirmation. Each transaction ID can be used for one request only.</span>
        </ConfirmDialog>
      )}
    </Panel>
  )
}

function RequestStatus({ r }: { r: PaymentRequestDto }) {
  if (r.status === 'approved') return <Badge tone="ok">Approved</Badge>
  if (r.status === 'cancelled') return <Badge tone="bad">Cancelled</Badge>
  return <Badge tone="warn">Pending review</Badge>
}

export function Subscription() {
  const { subscription, refreshSubscription, navigate } = useApp()
  const configured = subscription?.configured !== false
  const plans = useResource(() => call('subscription:plans'), [], { enabled: configured })
  const requests = useResource(() => call('subscription:requests'), [subscription?.status?.pendingRequestId, subscription?.status?.subscription?.activatedAt], { enabled: configured })
  const [selected, setSelected] = useState<string | null>(null)
  const pendingId = subscription?.status?.pendingRequestId
  const lifetime = subscription?.status?.subscription?.status === 'active' && subscription.status.subscription.planCode === 'lifetime'

  return (
    <div className="page">
      <StatusCard />
      {configured && (
        <>
          {pendingId && <Banner tone="info" icon="clock" title="Payment under review">Request {pendingId.slice(0, 8)} was emailed to {plans.data?.payments.businessEmail ?? 'ourswebsolutions@gmail.com'} and is waiting for the payment to be confirmed. You can keep using TradePilot meanwhile{subscription?.access.allowed ? '' : ' (paid features unlock as soon as it is approved)'}.</Banner>}
          {selected && plans.data && !pendingId ? (
            <PaymentForm plans={plans.data} planCode={selected} onCancel={() => setSelected(null)} onSubmitted={() => { setSelected(null); void refreshSubscription(); void requests.reload() }} />
          ) : (
            <Panel title="Plans">
              {plans.data && !plans.data.payments.available && <div style={{ marginBottom: 12 }}><PaymentsUnavailable payments={plans.data.payments} onRetry={plans.reload} /></div>}
              {plans.data?.payments.available && !plans.data.clientEmail.configured && (
                <div style={{ marginBottom: 12 }}>
                  <Banner tone="warn" title="Configure your email connection before paying" actions={<Button size="sm" onClick={() => navigate('settings', { tab: 'smtp' })}>Open SMTP settings</Button>}>{plans.data.clientEmail.problem}</Banner>
                </div>
              )}
              {plans.error ? <ErrorState message={plans.error} onRetry={plans.reload} /> : !plans.data ? <Skeleton height={140} /> : (
                <div className="grid cols-2">
                  {plans.data.plans.map((p) => {
                    const disabled = Boolean(pendingId) || lifetime
                    return (
                      <div key={p.code} className="plan-card">
                        <div className="p-name">{p.name}</div>
                        <div className="price">{cents(p.priceCents, p.currency)}<small>{p.billing === 'monthly' ? 'per month' : 'one-time payment'}</small></div>
                        <p className="muted" style={{ margin: 0 }}>{p.description}</p>
                        <div>
                          <Button variant={p.code === 'lifetime' ? 'primary' : 'default'} onClick={() => setSelected(p.code)} disabled={disabled}>
                            {subscription?.status?.subscription?.status === 'active' && p.code === 'monthly' && !lifetime ? 'Renew monthly' : `Choose ${p.name}`}
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              {lifetime && <p className="muted" style={{ marginBottom: 0 }}>You have lifetime access — no further payments are needed.</p>}
              {subscription?.status?.subscription?.status === 'active' && !lifetime && <p className="faint" style={{ marginBottom: 0 }}>Renewing early extends your plan from its current end date ({date(subscription.status.subscription.expiresAt)}).</p>}
              <p className="faint" style={{ marginBottom: 0, fontSize: 12 }}>Payments are confirmed by email after they are verified. Questions about a payment: <span className="selectable mono">{plans.data?.payments.businessEmail ?? 'ourswebsolutions@gmail.com'}</span></p>
            </Panel>
          )}
          <Panel title="Payment requests" flush>
            {requests.error ? <ErrorState message={requests.error} onRetry={requests.reload} /> : !requests.data ? <div className="panel-body"><Skeleton /></div> : requests.data.length === 0 ? (
              <Empty icon="card" title="No payment requests yet">Submitted payments and their review outcome appear here.</Empty>
            ) : (
              <table className="data">
                <thead><tr><th>Submitted</th><th>Request</th><th>Plan</th><th className="r">Amount</th><th>Transaction ID</th><th>Status</th><th>Decided</th><th>Details</th></tr></thead>
                <tbody>
                  {requests.data.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap faint">{dateTime(r.createdAt)}</td>
                      <td className="mono">{r.id.slice(0, 8)}</td>
                      <td style={{ textTransform: 'capitalize' }}>{r.planCode}</td>
                      <td className="r num">{cents(r.amountCents, r.currency)}</td>
                      <td className="mono">{r.transactionId}</td>
                      <td><RequestStatus r={r} /></td>
                      <td className="nowrap faint">{r.decidedAt ? dateTime(r.decidedAt) : '—'}</td>
                      <td className="muted">{r.status === 'cancelled' ? r.cancellationReason : r.status === 'approved' ? 'Plan activated' : 'Awaiting review'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}
