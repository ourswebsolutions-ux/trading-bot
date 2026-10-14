import { useEffect, useState } from 'react'
import type { Instrument, IntegrationId, IntegrationView, MarketHealth } from '@shared/ipc'
import { Icon, type IconName } from '../components/icons'
import { Badge, Banner, Button, ConfirmDialog, Field, PasswordInput, Panel, Progress, Spinner, StatusDot, useToast } from '../components/ui'
import { call, errorMessage, fieldErrors } from '../lib/api'
import { ago, dateTime } from '../lib/format'
import { useEvent, useNow, useResource } from '../lib/hooks'
import { useApp } from '../lib/state'

interface FieldDef {
  key: string
  label: string
  secret?: boolean
  hint?: string
  options?: { value: string; label: string }[]
  type?: string
  placeholder?: string
}

export const INTEGRATION_META: Record<IntegrationId, { title: string; icon: IconName; blurb: string; fields: FieldDef[] }> = {
  delta: {
    title: 'Delta Exchange',
    icon: 'exchange',
    blurb: 'Read-only account access: balances, positions and order history. Market data works without keys. Order placement is disabled in this release; create a key with "Read Data" permission only.',
    fields: [
      { key: 'region', label: 'Account region', hint: 'India and Global are separate exchanges with separate API keys and instruments.' },
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'apiSecret', label: 'API secret', secret: true }
    ]
  },
  marketdata: {
    title: 'Market Data',
    icon: 'trading',
    blurb: 'Live prices stream over Delta Exchange’s official WebSocket; REST polling takes over automatically when the stream is unavailable. Every price shows whether it is live, delayed, stale or unavailable.',
    fields: [
      { key: 'useWebSocket', label: 'Transport', options: [{ value: 'true', label: 'WebSocket streaming with REST fallback' }, { value: 'false', label: 'REST polling only' }] },
      { key: 'staleAfterSec', label: 'Mark data stale after (seconds)', type: 'number', hint: 'Delta publishes tickers about every 5 s.' },
      { key: 'pollIntervalSec', label: 'REST polling interval (seconds)', type: 'number' }
    ]
  },
  openai: {
    title: 'OpenAI',
    icon: 'brain',
    blurb: 'Used to draft strategies from plain-language descriptions. AI output is always a draft you review; it can never place orders.',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, placeholder: 'sk-…' },
      { key: 'model', label: 'Model' },
      { key: 'maxOutputTokens', label: 'Max output tokens per request', type: 'number' },
      { key: 'timeoutSec', label: 'Request timeout (seconds)', type: 'number' },
      { key: 'dailyRequestLimit', label: 'Daily request limit', type: 'number' },
      { key: 'dailyTokenLimit', label: 'Daily token budget', type: 'number' }
    ]
  },
  anthropic: {
    title: 'Anthropic Claude',
    icon: 'brain',
    blurb: 'Used to draft strategies from plain-language descriptions through the official Anthropic SDK. AI output is always a draft you review; it can never place orders.',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, placeholder: 'sk-ant-…' },
      { key: 'model', label: 'Model' },
      { key: 'maxOutputTokens', label: 'Max output tokens per request', type: 'number' },
      { key: 'timeoutSec', label: 'Request timeout (seconds)', type: 'number' },
      { key: 'dailyRequestLimit', label: 'Daily request limit', type: 'number' },
      { key: 'dailyTokenLimit', label: 'Daily token budget', type: 'number' }
    ]
  },
  smtp: {
    title: 'SMTP Email',
    icon: 'mail',
    blurb: 'Your mail server for alert email from this computer. (Subscription emails are sent by the TradePilot server using the same SMTP module.)',
    fields: [
      { key: 'host', label: 'SMTP host', placeholder: 'smtp.example.com' },
      { key: 'port', label: 'Port', type: 'number' },
      { key: 'secure', label: 'Encryption', options: [{ value: 'false', label: 'STARTTLS (usually port 587)' }, { value: 'true', label: 'Implicit TLS (usually port 465)' }] },
      { key: 'requireTLS', label: 'Require TLS', options: [{ value: 'true', label: 'Yes — refuse unencrypted connections' }, { value: 'false', label: 'No — allow plain text (not recommended)' }] },
      { key: 'username', label: 'Username', hint: 'Leave blank if the server needs no login' },
      { key: 'password', label: 'Password', secret: true, hint: 'Gmail / Microsoft 365 require an app password' },
      { key: 'from', label: 'Sender address', placeholder: 'TradePilot <alerts@example.com>' },
      { key: 'testRecipient', label: 'Test recipient', type: 'email' },
      { key: 'tradingAlerts', label: 'Trading alerts by email', options: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'On — orders, fills, stops, limits, emergency stop' }] },
      { key: 'alertRecipient', label: 'Alert recipient', type: 'email', hint: 'Defaults to the test recipient' }
    ]
  },
  whatsapp: {
    title: 'WhatsApp Business',
    icon: 'chat',
    blurb: 'WhatsApp Cloud API (Meta). Business-initiated messages must use an approved template and may only go to people who opted in.',
    fields: [
      { key: 'phoneNumberId', label: 'Phone number ID', hint: 'WhatsApp Manager → API Setup' },
      { key: 'businessAccountId', label: 'WhatsApp Business Account ID', hint: 'Optional; needed to verify templates' },
      { key: 'accessToken', label: 'Access token', secret: true, hint: 'Use a permanent System User token' },
      { key: 'apiVersion', label: 'Graph API version', placeholder: 'v23.0' },
      { key: 'templateName', label: 'Test template name', placeholder: 'hello_world' },
      { key: 'templateLanguage', label: 'Template language', placeholder: 'en_US' },
      { key: 'tradingAlerts', label: 'Trading alerts on WhatsApp', options: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'On' }] },
      { key: 'alertTemplateName', label: 'Alert template name', hint: 'An approved template whose body has one variable, e.g. "TradePilot: {{1}}"' },
      { key: 'alertTemplateLanguage', label: 'Alert template language', placeholder: 'en_US' },
      { key: 'alertRecipient', label: 'Alert recipient', placeholder: '+91 98765 43210', hint: 'Must be on the opt-in list below' }
    ]
  }
}

export function stateBadge(v: IntegrationView) {
  if (v.state === 'connected') return <Badge tone="ok"><StatusDot tone="ok" /> Connected</Badge>
  if (v.state === 'failed') return <Badge tone="bad">Failed</Badge>
  if (v.state === 'untested') return <Badge tone="warn">Saved · not tested</Badge>
  return <Badge>Not configured</Badge>
}

function useProgress(id: IntegrationId): string {
  const [step, setStep] = useState('')
  useEvent('integrations:progress', (p) => p.id === id && setStep(p.step))
  return step
}

function StatusStrip({ view }: { view: IntegrationView }) {
  const now = useNow(15_000)
  return (
    <dl className="kv" style={{ gridTemplateColumns: '190px 1fr' }}>
      <dt>Last successful connection</dt>
      <dd>{view.lastSuccessAt ? `${dateTime(view.lastSuccessAt)} (${ago(view.lastSuccessAt, now)})` : 'never'}</dd>
      <dt>Last check</dt>
      <dd>{view.checkedAt ? `${dateTime(view.checkedAt)} (${ago(view.checkedAt, now)})` : view.state === 'not_configured' ? '—' : 'not tested since last change'}</dd>
    </dl>
  )
}

function UsageMeter({ usage }: { usage: { requestsToday: number; tokensToday: number; failedToday: number; dailyRequestLimit: number; dailyTokenLimit: number } }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div className="panel-title">Usage today (UTC)</div>
      <div className="form-row">
        <div style={{ display: 'grid', gap: 4 }}>
          <span className="faint" style={{ fontSize: 12 }}>Requests {usage.requestsToday} / {usage.dailyRequestLimit}{usage.failedToday ? ` · ${usage.failedToday} failed` : ''}</span>
          <Progress value={(usage.requestsToday / usage.dailyRequestLimit) * 100} />
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <span className="faint" style={{ fontSize: 12 }}>Tokens {usage.tokensToday.toLocaleString()} / {usage.dailyTokenLimit.toLocaleString()}</span>
          <Progress value={(usage.tokensToday / usage.dailyTokenLimit) * 100} />
        </div>
      </div>
    </div>
  )
}

function MarketHealthDetails({ health }: { health: MarketHealth }) {
  const now = useNow(2000)
  return (
    <dl className="kv" style={{ gridTemplateColumns: '190px 1fr' }}>
      <dt>Region</dt><dd>{health.regionLabel}</dd>
      <dt>Transport</dt><dd>{health.transport === 'websocket' ? 'WebSocket (live)' : health.transport === 'rest' ? 'REST polling' : 'Offline'} · socket {health.socket}</dd>
      <dt>Last stream message</dt><dd>{health.lastMessageAt ? ago(health.lastMessageAt, now) : '—'}</dd>
      <dt>Last REST response</dt><dd>{health.lastRestAt ? ago(health.lastRestAt, now) : '—'}</dd>
      <dt>Instruments</dt><dd>{health.instruments ? `${health.instruments} live perpetuals (loaded ${ago(health.instrumentsAt, now)})` : 'not loaded'}</dd>
      <dt>Reconnects</dt><dd>{health.reconnects} · {health.duplicatesIgnored} duplicate updates ignored</dd>
      {health.unsupported.length > 0 && <><dt>Not listed in region</dt><dd>{health.unsupported.join(', ')}</dd></>}
      {health.lastError && <><dt>Last error</dt><dd className="down">{health.lastError}</dd></>}
    </dl>
  )
}

function DefaultInstrument() {
  const { prefs, setPrefs } = useApp()
  const toast = useToast()
  const instruments = useResource(() => call('market:instruments', {}), [])
  const [saving, setSaving] = useState(false)
  const current = prefs?.defaultSymbol ?? ''
  const listed = instruments.data?.some((i) => i.symbol === current)
  return (
    <Field label="Default instrument" hint={instruments.error ? instruments.error : listed === false ? `${current} is not listed in this region — choose another.` : 'Shown on the dashboard and trading screen.'} error={listed === false ? `${current} unavailable in this region` : undefined}>
      <select
        className="select mono"
        value={current}
        disabled={!instruments.data || saving}
        onChange={async (e) => {
          setSaving(true)
          try {
            setPrefs(await call('settings:savePreferences', { defaultSymbol: e.target.value }))
            toast({ tone: 'ok', title: `Default instrument set to ${e.target.value}` })
          } catch (err) {
            toast({ tone: 'bad', title: 'Not saved', body: errorMessage(err) })
          } finally {
            setSaving(false)
          }
        }}
      >
        {!listed && <option value={current}>{current}</option>}
        {(instruments.data ?? []).map((i: Instrument) => <option key={i.symbol} value={i.symbol}>{i.symbol} — {i.description}</option>)}
      </select>
    </Field>
  )
}

function WhatsAppConsents({ view, run, busy }: { view: IntegrationView; run: (action: string, params?: Record<string, unknown>) => Promise<void>; busy: string | null }) {
  const consents = (view.extras.consents as { id: string; recipient: string; note: string; consentedAt: string }[] | undefined) ?? []
  const templates = (view.extras.templates as { name: string; status: string; language: string }[] | undefined) ?? []
  const [recipient, setRecipient] = useState('')
  const [note, setNote] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [sendTo, setSendTo] = useState<string | null>(null)
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="panel-title">Opt-in recipients</div>
      <p className="muted" style={{ margin: 0 }}>WhatsApp Business policy requires recipients to opt in before you message them. Test messages can only go to numbers on this list.</p>
      {consents.length > 0 ? (
        <div className="chip-list">
          {consents.map((c) => (
            <div key={c.id} className="chip-row">
              <span className="mono">+{c.recipient}</span>
              <span className="faint" style={{ flex: 1, fontSize: 12 }}>{c.note || 'opted in'} · {dateTime(c.consentedAt)}</span>
              <Button size="sm" icon="chat" disabled={view.state === 'not_configured' || busy !== null} onClick={() => setSendTo(c.recipient)}>Send test template</Button>
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run('revokeConsent', { id: c.id })}>Remove</Button>
            </div>
          ))}
        </div>
      ) : <span className="faint">No opted-in recipients yet.</span>}
      <div className="form-row" style={{ alignItems: 'end' }}>
        <Field label="Phone number (international format)">
          <input className="input mono" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="+91 98765 43210" />
        </Field>
        <Field label="How did they opt in? (optional)">
          <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. signed up on website form" />
        </Field>
      </div>
      <label className="check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /><span>This person agreed to receive WhatsApp messages from my business.</span></label>
      <div>
        <Button size="sm" icon="plus" loading={busy === 'addConsent'} disabled={!recipient || !confirmed || busy !== null} onClick={async () => {
          await run('addConsent', { recipient, confirmed, note })
          setRecipient('')
          setNote('')
          setConfirmed(false)
        }}>Add to opt-in list</Button>
      </div>
      {templates.length > 0 && (
        <div className="faint" style={{ fontSize: 12 }}>Templates on this account: {templates.map((t) => `${t.name} (${t.language}, ${t.status.toLowerCase()})`).join(' · ')}</div>
      )}
      {sendTo && (
        <ConfirmDialog title={`Send test template to +${sendTo}?`} confirmLabel="Send message" onClose={() => setSendTo(null)} onConfirm={() => run('sendTest', { recipient: sendTo })}>
          Sends the approved template “{view.config.templateName}” ({view.config.templateLanguage}) through the WhatsApp Cloud API. Meta may charge for template conversations.
        </ConfirmDialog>
      )}
    </div>
  )
}

export function IntegrationSection({ view, onChange, storageOk }: { view: IntegrationView; onChange: () => void; storageOk: boolean }) {
  const toast = useToast()
  const meta = INTEGRATION_META[view.id]
  const step = useProgress(view.id)
  const [config, setConfig] = useState<Record<string, string>>(view.config)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  useEffect(() => {
    setConfig(view.config)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id, JSON.stringify(view.config)])

  const dirty = Object.values(secrets).some((v) => v !== '') || JSON.stringify(config) !== JSON.stringify(view.config)
  const hasSecrets = meta.fields.some((f) => f.secret)

  const save = async () => {
    setSaving(true)
    setErrors({})
    try {
      const filled = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== ''))
      await call('integrations:save', { id: view.id, config, secrets: filled })
      setSecrets({})
      onChange()
      toast({ tone: 'ok', title: `${meta.title} settings saved`, body: 'Run a connection test to verify them.' })
    } catch (err) {
      setErrors(fieldErrors(err))
      toast({ tone: 'bad', title: 'Not saved', body: errorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  /** Runs a provider action; rejects when it failed so confirm dialogs stay open for a retry. */
  const run = async (action: string, params?: Record<string, unknown>) => {
    setBusy(action)
    let result
    try {
      ;({ result } = await call('integrations:action', { id: view.id, action, params }))
    } catch (err) {
      toast({ tone: 'bad', title: 'Could not run', body: errorMessage(err) })
      throw err
    } finally {
      setBusy(null)
    }
    onChange()
    const title = action === 'test' ? `${meta.title}: connection ${result.ok ? 'OK' : 'failed'}` : result.ok ? 'Done' : 'Action failed'
    toast({ tone: result.ok ? 'ok' : 'bad', title, body: result.message })
    if (!result.ok) throw new Error(result.message)
  }
  const runQuiet = (action: string, params?: Record<string, unknown>) => run(action, params).catch(() => undefined)

  const models = (view.extras.models as { id: string; label: string }[] | undefined) ?? []
  const regions = (view.extras.regions as { id: string; label: string }[] | undefined) ?? []
  const usage = view.extras.usage as Parameters<typeof UsageMeter>[0]['usage'] | undefined
  const health = view.extras.health as MarketHealth | undefined
  const lastAction = view.lastAction && view.lastAction.action !== 'test' ? view.lastAction : null

  const renderField = (f: FieldDef) => {
    const stored = f.secret ? view.secrets[f.key] : null
    if (f.secret) {
      return (
        <Field key={f.key} label={f.label} error={errors[f.key]} hint={stored ? `Stored (${stored}). Leave blank to keep it.` : f.hint ?? 'Encrypted with your OS keychain; never shown again.'}>
          <PasswordInput className="mono" invalid={Boolean(errors[f.key])} autoComplete="off" placeholder={stored ? '••••••••' : f.placeholder} value={secrets[f.key] ?? ''} onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })} disabled={!storageOk} />
        </Field>
      )
    }
    const options = f.key === 'region' ? regions.map((r) => ({ value: r.id, label: r.label })) : f.options
    if (f.key === 'model' && models.length > 0) {
      const inList = models.some((m) => m.id === config.model)
      return (
        <Field key={f.key} label={f.label} error={errors[f.key]} hint={inList ? undefined : 'Not in the model list for this key — refresh or choose another.'}>
          <select className="select mono" value={config.model ?? ''} onChange={(e) => setConfig({ ...config, model: e.target.value })}>
            {!inList && <option value={config.model}>{config.model}</option>}
            {models.map((m) => <option key={m.id} value={m.id}>{m.label === m.id ? m.id : `${m.label} (${m.id})`}</option>)}
          </select>
        </Field>
      )
    }
    return (
      <Field key={f.key} label={f.label} error={errors[f.key]} hint={f.key === 'model' ? 'Run a connection test to load the models available to your key.' : f.hint}>
        {options ? (
          <select className="select" value={config[f.key] ?? ''} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <input className={`input ${f.type === 'number' || f.key === 'model' ? 'mono' : ''} ${errors[f.key] ? 'invalid' : ''}`} type={f.type === 'email' ? 'email' : 'text'} inputMode={f.type === 'number' ? 'numeric' : undefined} placeholder={f.placeholder} value={config[f.key] ?? ''} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
        )}
      </Field>
    )
  }

  return (
    <Panel title={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><Icon name={meta.icon} size={14} />{meta.title}</span>} actions={stateBadge(view)}>
      <div className="form" style={{ maxWidth: 760 }}>
        <p className="muted" style={{ margin: 0 }}>{meta.blurb}</p>
        {hasSecrets && !storageOk && <Banner tone="bad" title="Secure storage unavailable">Credentials cannot be saved until the operating system keychain is available.</Banner>}
        <StatusStrip view={view} />
        {view.message && view.state !== 'not_configured' && (
          <Banner tone={view.state === 'connected' ? 'ok' : view.state === 'failed' ? 'bad' : 'info'} title={view.state === 'connected' ? 'Last connection test succeeded' : view.state === 'failed' ? 'Last connection test failed' : undefined}>{view.message}</Banner>
        )}
        {lastAction && <Banner tone={lastAction.ok ? 'ok' : 'bad'} title={`Last action ${lastAction.ok ? 'succeeded' : 'failed'} · ${ago(lastAction.at)}`}>{lastAction.message}</Banner>}
        {view.id === 'marketdata' && health && <MarketHealthDetails health={health} />}

        <div className="form-row">{meta.fields.map(renderField)}</div>
        {view.id === 'marketdata' && <div className="form-row"><DefaultInstrument /></div>}

        <div className="btn-row">
          <Button variant="primary" onClick={save} loading={saving} disabled={!dirty || busy !== null}>Save</Button>
          <Button icon="refresh" onClick={() => void runQuiet('test')} loading={busy === 'test'} disabled={view.state === 'not_configured' || dirty || busy !== null}>Test connection</Button>
          {(view.id === 'openai' || view.id === 'anthropic') && <Button icon="refresh" variant="ghost" onClick={() => void runQuiet('refreshModels')} loading={busy === 'refreshModels'} disabled={view.state === 'not_configured' || dirty || busy !== null}>Refresh models</Button>}
          {view.id === 'smtp' && <Button icon="mail" onClick={() => void runQuiet('sendTest')} loading={busy === 'sendTest'} disabled={view.state === 'not_configured' || dirty || busy !== null}>Send test email</Button>}
          {view.state !== 'not_configured' && hasSecrets && <Button variant="ghost" icon="trash" onClick={() => setClearing(true)} disabled={busy !== null}>Remove credentials</Button>}
          {busy && step && <span className="progress-step"><Spinner />{step}</span>}
          {dirty && !busy && <span className="faint" style={{ fontSize: 12 }}>Save changes before testing.</span>}
        </div>

        {usage && <UsageMeter usage={usage} />}
        {view.id === 'whatsapp' && <WhatsAppConsents view={view} run={run} busy={busy} />}
      </div>
      {clearing && (
        <ConfirmDialog title={`Remove ${meta.title} credentials?`} tone="danger" confirmLabel="Remove" onClose={() => setClearing(false)} onConfirm={async () => {
          try {
            await call('integrations:clear', { id: view.id })
            setSecrets({})
            onChange()
            toast({ tone: 'ok', title: `${meta.title} credentials removed` })
          } catch (err) {
            toast({ tone: 'bad', title: 'Could not remove', body: errorMessage(err) })
            throw err
          }
        }}>
          Stored keys and settings for {meta.title} are deleted from this computer.
        </ConfirmDialog>
      )}
    </Panel>
  )
}
