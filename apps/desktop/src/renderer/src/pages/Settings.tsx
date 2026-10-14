import { useEffect, useState } from 'react'
import type { GeneralPreferences, IntegrationId, IntegrationView } from '@shared/ipc'
import { Icon, type IconName } from '../components/icons'
import { Badge, Banner, Button, ConfirmDialog, ErrorState, Field, Panel, Progress, Skeleton, StatusDot, useToast } from '../components/ui'
import { call, errorMessage, fieldErrors } from '../lib/api'
import { ago, bytes, dateTime } from '../lib/format'
import { useResource } from '../lib/hooks'
import { useApp } from '../lib/state'
import { ChangePasswordForm } from './Auth'

type Tab = 'general' | 'security' | IntegrationId | 'updates' | 'about'

interface FieldDef { key: string; label: string; secret?: boolean; hint?: string; options?: { value: string; label: string }[]; type?: string; placeholder?: string }
const INTEGRATION_META: Record<IntegrationId, { title: string; icon: IconName; blurb: string; fields: FieldDef[] }> = {
  delta: {
    title: 'Delta Exchange', icon: 'exchange',
    blurb: 'Used for authenticated account data. Market data works without keys. Live order placement stays disabled in Phase 1. Create a read-only key if possible.',
    fields: [
      { key: 'baseUrl', label: 'API endpoint', options: [
        { value: 'https://api.india.delta.exchange', label: 'Delta Exchange India (production)' },
        { value: 'https://api.delta.exchange', label: 'Delta Exchange Global (production)' },
        { value: 'https://cdn-ind.testnet.deltaex.org', label: 'Delta Exchange India (testnet)' },
        { value: 'https://testnet-api.delta.exchange', label: 'Delta Exchange Global (testnet)' }
      ] },
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'apiSecret', label: 'API secret', secret: true }
    ]
  },
  openai: { title: 'OpenAI', icon: 'brain', blurb: 'API access for AI-assisted research features planned for Phase 2. The test lists available models.', fields: [{ key: 'apiKey', label: 'API key', secret: true, placeholder: 'sk-…' }] },
  anthropic: { title: 'Anthropic Claude', icon: 'brain', blurb: 'API access for Claude-assisted research features planned for Phase 2. The test calls the Models API.', fields: [{ key: 'apiKey', label: 'API key', secret: true, placeholder: 'sk-ant-…' }] },
  smtp: {
    title: 'SMTP email', icon: 'mail',
    blurb: 'Your own mail server for trade and system alerts from this computer. (Subscription emails are sent by the TradePilot server, not from here.) The test sends a real message.',
    fields: [
      { key: 'host', label: 'SMTP host', placeholder: 'smtp.example.com' },
      { key: 'port', label: 'Port', type: 'number' },
      { key: 'secure', label: 'Encryption', options: [{ value: 'false', label: 'STARTTLS (port 587)' }, { value: 'true', label: 'Implicit TLS (port 465)' }] },
      { key: 'username', label: 'Username', hint: 'Leave blank if the server needs no login' },
      { key: 'password', label: 'Password', secret: true },
      { key: 'from', label: 'From address', type: 'email' },
      { key: 'testRecipient', label: 'Send test email to', type: 'email' }
    ]
  },
  whatsapp: {
    title: 'WhatsApp Business', icon: 'chat',
    blurb: 'WhatsApp Cloud API credentials for alert delivery (Phase 2). The test verifies the phone number ID and access token with Meta Graph API.',
    fields: [
      { key: 'phoneNumberId', label: 'Phone number ID' },
      { key: 'apiVersion', label: 'Graph API version', placeholder: 'v21.0' },
      { key: 'accessToken', label: 'Access token', secret: true }
    ]
  }
}

function stateBadge(v: IntegrationView) {
  if (v.state === 'connected') return <Badge tone="ok"><StatusDot tone="ok" /> Connected</Badge>
  if (v.state === 'failed') return <Badge tone="bad">Failed</Badge>
  if (v.state === 'untested') return <Badge tone="warn">Saved · not tested</Badge>
  return <Badge>Not configured</Badge>
}

function IntegrationForm({ view, onChange, storageOk }: { view: IntegrationView; onChange: (v: IntegrationView) => void; storageOk: boolean }) {
  const toast = useToast()
  const meta = INTEGRATION_META[view.id]
  const [config, setConfig] = useState<Record<string, string>>(view.config)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [clearing, setClearing] = useState(false)
  useEffect(() => {
    setConfig(view.config)
    setSecrets({})
    setErrors({})
  }, [view.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = Object.keys(secrets).some((k) => secrets[k] !== '') || JSON.stringify(config) !== JSON.stringify(view.config)

  const save = async () => {
    setSaving(true)
    setErrors({})
    try {
      const filled = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== ''))
      const v = await call('integrations:save', { id: view.id, config, secrets: filled })
      onChange(v)
      setSecrets({})
      toast({ tone: 'ok', title: `${meta.title} settings saved`, body: 'Run a connection test to verify them.' })
    } catch (err) {
      setErrors(fieldErrors(err))
      toast({ tone: 'bad', title: 'Not saved', body: errorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const v = await call('integrations:test', { id: view.id })
      onChange(v)
      toast(v.state === 'connected' ? { tone: 'ok', title: `${meta.title} connected`, body: v.message ?? undefined } : { tone: 'bad', title: `${meta.title} test failed`, body: v.message ?? undefined })
    } catch (err) {
      toast({ tone: 'bad', title: 'Test could not run', body: errorMessage(err) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Panel title={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><Icon name={meta.icon} size={14} />{meta.title}</span>} actions={stateBadge(view)}>
      <div className="form" style={{ maxWidth: 640 }}>
        <p className="muted" style={{ margin: 0 }}>{meta.blurb}</p>
        {!storageOk && meta.fields.some((f) => f.secret) && <Banner tone="bad" title="Secure storage unavailable">Credentials cannot be saved until the operating system keychain is available.</Banner>}
        {view.state !== 'not_configured' && view.message && (
          <Banner tone={view.state === 'connected' ? 'ok' : view.state === 'failed' ? 'bad' : 'info'} title={view.state === 'connected' ? 'Last test succeeded' : view.state === 'failed' ? 'Last test failed' : undefined}>
            {view.message} {view.checkedAt && <span className="faint">· {ago(view.checkedAt)}</span>}
          </Banner>
        )}
        <div className="form-row">
          {meta.fields.map((f) => {
            const hintStored = f.secret && view.secrets[f.key]
            return (
              <Field key={f.key} label={f.label} error={errors[f.key]} hint={f.secret ? (hintStored ? `Stored (${view.secrets[f.key]}). Leave blank to keep it.` : 'Encrypted with your OS keychain; never shown again.') : f.hint}>
                {f.options ? (
                  <select className="select" value={config[f.key] ?? ''} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}>
                    {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : f.secret ? (
                  <input className={`input mono ${errors[f.key] ? 'invalid' : ''}`} type="password" autoComplete="off" placeholder={hintStored ? '••••••••' : f.placeholder} value={secrets[f.key] ?? ''} onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })} />
                ) : (
                  <input className={`input ${errors[f.key] ? 'invalid' : ''}`} type={f.type ?? 'text'} placeholder={f.placeholder} value={config[f.key] ?? ''} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
                )}
              </Field>
            )
          })}
        </div>
        <div className="btn-row">
          <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>Save</Button>
          <Button icon="refresh" onClick={test} loading={testing} disabled={view.state === 'not_configured' || dirty}>Test connection</Button>
          {view.state !== 'not_configured' && <Button variant="ghost" icon="trash" onClick={() => setClearing(true)}>Remove credentials</Button>}
          {dirty && <span className="faint" style={{ fontSize: 12 }}>Save changes before testing.</span>}
        </div>
      </div>
      {clearing && (
        <ConfirmDialog title={`Remove ${meta.title} credentials?`} tone="danger" confirmLabel="Remove" onClose={() => setClearing(false)} onConfirm={async () => {
          try {
            onChange(await call('integrations:clear', { id: view.id }))
            setConfig({})
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

function General() {
  const { prefs, setPrefs } = useApp()
  const toast = useToast()
  const [draft, setDraft] = useState<GeneralPreferences | null>(prefs)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  useEffect(() => setDraft(prefs), [prefs])
  if (!draft) return <Skeleton height={200} />
  const set = <K extends keyof GeneralPreferences>(k: K, v: GeneralPreferences[K]) => setDraft({ ...draft, [k]: v })
  const save = async () => {
    setSaving(true)
    setErrors({})
    try {
      setPrefs(await call('settings:savePreferences', draft))
      toast({ tone: 'ok', title: 'Preferences saved' })
    } catch (err) {
      setErrors(fieldErrors(err))
      toast({ tone: 'bad', title: 'Not saved', body: errorMessage(err) })
    } finally {
      setSaving(false)
    }
  }
  return (
    <Panel title="General">
      <div className="form" style={{ maxWidth: 640 }}>
        <div className="form-row">
          <Field label="Theme">
            <select className="select" value={draft.theme} onChange={(e) => set('theme', e.target.value as GeneralPreferences['theme'])}>
              <option value="dark">Dark</option><option value="light">Light</option><option value="system">Match system</option>
            </select>
          </Field>
          <Field label="Auto-lock after inactivity" error={errors.autoLockMinutes} hint="Minutes (1–240). The app also locks when your computer locks or sleeps.">
            <input className="input mono" type="number" min={1} max={240} value={draft.autoLockMinutes} onChange={(e) => set('autoLockMinutes', Number(e.target.value))} />
          </Field>
          <Field label="Default market" error={errors.defaultSymbol}>
            <input className="input mono" value={draft.defaultSymbol} onChange={(e) => set('defaultSymbol', e.target.value.toUpperCase())} />
          </Field>
          <Field label="Python interpreter" error={errors.pythonPath} hint="Used to run the trading engine (Python 3.10+).">
            <input className="input mono" value={draft.pythonPath} onChange={(e) => set('pythonPath', e.target.value)} />
          </Field>
        </div>
        <label className="check"><input type="checkbox" checked={draft.desktopNotifications} onChange={(e) => set('desktopNotifications', e.target.checked)} /><span>Show desktop notifications</span></label>
        <label className="check"><input type="checkbox" checked={draft.autoInstallUpdates} onChange={(e) => set('autoInstallUpdates', e.target.checked)} /><span>Install downloaded updates automatically while TradePilot is locked <span className="faint">— otherwise they install when you restart or quit</span></span></label>
        <div><Button variant="primary" onClick={save} loading={saving} disabled={JSON.stringify(draft) === JSON.stringify(prefs)}>Save preferences</Button></div>
      </div>
    </Panel>
  )
}

function Security({ storage }: { storage: { available: boolean; backend: string; message: string | null } | undefined }) {
  const { setAuth } = useApp()
  return (
    <div className="grid" style={{ gap: 16 }}>
      <Panel title="Change password"><ChangePasswordForm /></Panel>
      <Panel title="Session">
        <div className="form" style={{ maxWidth: 640 }}>
          <p className="muted" style={{ margin: 0 }}>Lock TradePilot when you step away (Ctrl+Shift+L). Repeated incorrect passwords trigger a temporary lockout that survives restarts.</p>
          <div><Button icon="lock" onClick={() => void call('auth:lock').then(setAuth)}>Lock now</Button></div>
        </div>
      </Panel>
      <Panel title="Credential storage">
        {!storage ? <Skeleton /> : storage.available ? (
          <Banner tone="ok" title={`Encrypted with ${storage.backend}`}>API keys and passwords are encrypted using your operating system's credential store before they are written to disk, and never leave the main process.</Banner>
        ) : <Banner tone="bad" title="Secure storage unavailable">{storage.message}</Banner>}
      </Panel>
    </div>
  )
}

function Updates() {
  const { updates } = useApp()
  const toast = useToast()
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  if (!updates) return <Skeleton height={160} />
  const p = updates.progress
  const phaseLabel: Record<string, string> = {
    disabled: 'Not configured', idle: 'Waiting', checking: 'Checking for updates…', available: 'Update found', downloading: 'Downloading', downloaded: 'Ready to install', up_to_date: 'Up to date', error: 'Update failed', installing: 'Installing…'
  }
  return (
    <Panel title="Software updates">
      <div className="form" style={{ maxWidth: 680 }}>
        <dl className="kv">
          <dt>Installed version</dt><dd className="mono">{updates.currentVersion}</dd>
          <dt>Status</dt><dd>{phaseLabel[updates.phase]}{updates.availableVersion && updates.phase !== 'up_to_date' ? <span className="mono"> · v{updates.availableVersion}</span> : null}</dd>
          <dt>Last checked</dt><dd>{updates.lastCheckedAt ? `${dateTime(updates.lastCheckedAt)} (${ago(updates.lastCheckedAt)})` : '—'}</dd>
          {updates.nextRetryAt && <><dt>Next retry</dt><dd>{dateTime(updates.nextRetryAt)}</dd></>}
          <dt>Update feed</dt><dd className="mono" style={{ fontSize: 12 }}>{updates.feedUrl ?? '—'}</dd>
        </dl>
        {updates.message && <Banner tone={updates.phase === 'error' ? 'bad' : updates.phase === 'disabled' ? 'warn' : updates.phase === 'downloaded' ? 'ok' : 'info'}>{updates.message}</Banner>}
        {updates.phase === 'downloading' && p && (
          <div style={{ display: 'grid', gap: 6 }}>
            <Progress value={p.percent} />
            <span className="faint mono" style={{ fontSize: 12 }}>{p.percent.toFixed(1)}% · {bytes(p.transferred)} of {bytes(p.total)} · {bytes(Math.round(p.bytesPerSecond))}/s</span>
          </div>
        )}
        <div className="btn-row">
          <Button icon="refresh" loading={checking || updates.phase === 'checking'} disabled={updates.phase === 'disabled' || updates.phase === 'downloading' || updates.phase === 'downloaded' || updates.phase === 'installing'} onClick={async () => {
            setChecking(true)
            try {
              const s = await call('updates:check')
              if (s.phase === 'up_to_date') toast({ tone: 'ok', title: 'TradePilot is up to date' })
            } catch (err) {
              toast({ tone: 'bad', title: 'Check failed', body: errorMessage(err) })
            } finally {
              setChecking(false)
            }
          }}>Check for updates</Button>
          {updates.phase === 'downloaded' && <Button variant="primary" icon="download" loading={installing} onClick={async () => { setInstalling(true); try { await call('updates:install') } catch (err) { setInstalling(false); toast({ tone: 'bad', title: 'Install failed', body: errorMessage(err) }) } }}>Restart and install v{updates.availableVersion}</Button>}
        </div>
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>Updates download in the background and are verified (SHA-512, plus code signature on Windows/macOS) before installing. Your password, strategies, settings and subscription are kept.</p>
      </div>
    </Panel>
  )
}

function About() {
  const { info, engine } = useApp()
  const toast = useToast()
  const [restarting, setRestarting] = useState(false)
  return (
    <Panel title="About this installation">
      <dl className="kv">
        <dt>Version</dt><dd className="mono">{info?.version}</dd>
        <dt>Platform</dt><dd className="mono">{info?.platform}{info && !info.packaged ? ' · development build' : ''}</dd>
        <dt>Subscription server</dt><dd className="mono">{info?.apiBaseUrl ?? 'not configured'}</dd>
        <dt>Device ID</dt><dd className="mono">{info?.deviceId ?? 'not registered yet'}</dd>
        <dt>Data folder</dt><dd className="mono selectable" style={{ fontSize: 12 }}>{info?.dataPath}</dd>
        <dt>Trading engine</dt><dd>{engine?.state}{engine?.python ? ` · Python ${engine.python}, engine ${engine.engineVersion}` : ''}{engine?.message ? <div className="faint">{engine.message}</div> : null}</dd>
        <dt>Live trading</dt><dd><Badge tone="warn">Disabled in Phase 1</Badge></dd>
      </dl>
      <div className="btn-row" style={{ marginTop: 16 }}>
        <Button icon="folder" onClick={() => call('shell:openDataFolder').catch((err) => toast({ tone: 'bad', title: 'Could not open folder', body: errorMessage(err) }))}>Open data folder</Button>
        <Button icon="cpu" loading={restarting} onClick={async () => {
          setRestarting(true)
          try {
            const s = await call('engine:restart')
            toast(s.state === 'ready' ? { tone: 'ok', title: 'Engine restarted', body: `Python ${s.python}` } : { tone: 'bad', title: 'Engine did not start', body: s.message ?? undefined })
          } catch (err) {
            toast({ tone: 'bad', title: 'Engine restart failed', body: errorMessage(err) })
          } finally {
            setRestarting(false)
          }
        }}>Restart engine</Button>
      </div>
    </Panel>
  )
}

export function Settings() {
  const { params } = useApp()
  const [tab, setTab] = useState<Tab>((params.tab as Tab) ?? 'general')
  const integrations = useResource(() => call('integrations:list'), [])
  const storage = useResource(() => call('settings:secretStorage'), [])
  useEffect(() => {
    if (params.tab) setTab(params.tab as Tab)
  }, [params.tab])

  const views = integrations.data ?? []
  const replace = () => void integrations.reload()
  const current = views.find((v) => v.id === tab)
  const item = (t: Tab, label: string, icon: IconName, tone?: 'ok' | 'bad' | 'warn') => (
    <button className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
      <Icon name={icon} size={14} /> <span style={{ flex: 1 }}>{label}</span> {tone !== undefined && <StatusDot tone={tone} />}
    </button>
  )
  const toneOf = (id: IntegrationId) => {
    const v = views.find((x) => x.id === id)
    return v?.state === 'connected' ? 'ok' : v?.state === 'failed' ? 'bad' : v?.state === 'untested' ? 'warn' : undefined
  }

  return (
    <div className="page">
      <div className="settings-layout">
        <nav className="subnav" aria-label="Settings sections">
          <div className="group">Application</div>
          {item('general', 'General', 'sliders')}
          {item('security', 'Security', 'shield')}
          {item('updates', 'Updates', 'download')}
          {item('about', 'About', 'info')}
          <div className="group">Connections</div>
          {(Object.keys(INTEGRATION_META) as IntegrationId[]).map((id) => item(id, INTEGRATION_META[id].title, INTEGRATION_META[id].icon, toneOf(id) ?? undefined))}
        </nav>
        <div>
          {tab === 'general' && <General />}
          {tab === 'security' && <Security storage={storage.data} />}
          {tab === 'updates' && <Updates />}
          {tab === 'about' && <About />}
          {tab in INTEGRATION_META && (integrations.error ? <ErrorState message={integrations.error} onRetry={integrations.reload} /> : current ? <IntegrationForm key={current.id} view={current} onChange={replace} storageOk={storage.data?.available !== false} /> : <Skeleton height={240} />)}
        </div>
      </div>
    </div>
  )
}
