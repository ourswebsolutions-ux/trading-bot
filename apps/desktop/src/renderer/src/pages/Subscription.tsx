import { useState } from 'react'
import type { PaymentRequestDto } from '@tradepilot/shared'
import { TRIAL_DURATION_MS, isValidTransactionId } from '@tradepilot/shared'
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

function PaymentForm({ plans, planCode, onCancel, onSubmitted }: { plans: PlansView; planCode: string; onCancel: () => void; onSubmitted: () => void }) {
  const toast = useToast()
  const plan = plans.plans.find((p) => p.code === planCode)!
  const [txn, setTxn] = useState('')
  const [email, setEmail] = useState('')
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
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const submit = async () => {
    setError(null)
    try {
      const created = await call('subscription:submit', { planCode, transactionId: txn, contactEmail: email || undefined, note: note || undefined, screenshotId: shot!.id })
      toast({ tone: 'ok', title: 'Payment request submitted', body: `Request ${created.id.slice(0, 8)} is pending review. You will be notified when it is processed.` })
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
          {plans.paymentInstructions ? <div className="instructions">{plans.paymentInstructions}</div> : <Banner tone="warn" title="Payment instructions are not available yet">The administrator has not configured payment details. Please check back later.</Banner>}
          <dl className="kv" style={{ gridTemplateColumns: '150px 1fr' }}>
            <dt>Amount</dt><dd className="mono" style={{ fontSize: 15 }}>{cents(plan.priceCents, plan.currency)} {plan.currency}</dd>
            <dt>Payment reference</dt><dd><span className="ref-code">{plans.referenceCode}</span><div className="faint" style={{ fontSize: 12 }}>Include this in the payment memo so we can match your payment.</div></dd>
          </dl>
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
          <Field label="Email for confirmation (optional)" error={errors.contactEmail} hint="We email you when the request is approved or cancelled.">
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Note to the reviewer (optional)" error={errors.note}>
            <textarea className="textarea" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="btn-row">
            <Button type="submit" variant="primary" disabled={!plans.paymentInstructions}>Submit for review</Button>
            <span className="faint" style={{ fontSize: 12 }}>Access is activated after an administrator confirms the payment.</span>
          </div>
        </form>
      </div>
      {confirming && (
        <ConfirmDialog title="Submit payment request?" confirmLabel="Submit request" onClose={() => setConfirming(false)} onConfirm={submit}>
          <dl className="kv" style={{ gridTemplateColumns: '130px 1fr', color: 'var(--text)' }}>
            <dt>Plan</dt><dd>{plan.name}</dd>
            <dt>Amount</dt><dd className="mono">{cents(plan.priceCents, plan.currency)}</dd>
            <dt>Transaction ID</dt><dd className="mono">{txn.trim().toUpperCase()}</dd>
            <dt>Screenshot</dt><dd>{shot?.name}</dd>
          </dl>
          <span>Each transaction ID can be used for one request only.</span>
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
  const { subscription, refreshSubscription } = useApp()
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
          {pendingId && <Banner tone="info" icon="clock" title="Payment under review">Request {pendingId.slice(0, 8)} is waiting for an administrator to confirm the payment. You can keep using TradePilot meanwhile{subscription?.access.allowed ? '' : ' (paid features unlock as soon as it is approved)'}.</Banner>}
          {selected && plans.data && !pendingId ? (
            <PaymentForm plans={plans.data} planCode={selected} onCancel={() => setSelected(null)} onSubmitted={() => { setSelected(null); void refreshSubscription(); void requests.reload() }} />
          ) : (
            <Panel title="Plans">
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
              <p className="faint" style={{ marginBottom: 0, fontSize: 12 }}>Payments are confirmed manually after review. Questions about a payment: <span className="selectable mono">ourswebsolutions@gmail.com</span></p>
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
