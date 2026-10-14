import { useEffect, useState } from 'react'
import type { AiPreferences, AiProviderId, GeneralPreferences, IntegrationId, IntegrationView } from '@shared/ipc'
import { INTEGRATION_META, IntegrationSection } from './Integrations'
import { Icon, type IconName } from '../components/icons'
import { Badge, Banner, Button, ConfirmDialog, ErrorState, Field, Panel, Progress, Skeleton, StatusDot, useToast } from '../components/ui'
import { call, errorMessage, fieldErrors } from '../lib/api'
import { ago, bytes, dateTime } from '../lib/format'
import { useResource } from '../lib/hooks'
import { useApp } from '../lib/state'
import { ChangePasswordForm } from './Auth'

type Tab = 'general' | 'ai' | 'security' | IntegrationId | 'updates' | 'about'

function General() {
  const { prefs, setPrefs, engine } = useApp()
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
          {engine?.bundled ? (
            <Field label="Trading engine" hint="Bundled with this installation; no Python installation is needed.">
              <input className="input mono" value={`Built-in engine ${engine.engineVersion ?? ''} (Python ${engine.python ?? '…'})`} readOnly />
            </Field>
          ) : (
            <Field label="Python interpreter" error={errors.pythonPath} hint="Used to run the trading engine (Python 3.10+).">
              <input className="input mono" value={draft.pythonPath} onChange={(e) => set('pythonPath', e.target.value)} />
            </Field>
          )}
        </div>
        <label className="check"><input type="checkbox" checked={draft.desktopNotifications} onChange={(e) => set('desktopNotifications', e.target.checked)} /><span>Show desktop notifications</span></label>
        <label className="check"><input type="checkbox" checked={draft.welcomeSound} onChange={(e) => set('welcomeSound', e.target.checked)} /><span>Play the welcome sound at start-up</span></label>
        <label className="check"><input type="checkbox" checked={draft.autoInstallUpdates} onChange={(e) => set('autoInstallUpdates', e.target.checked)} /><span>Install downloaded updates automatically while TradePilot is locked <span className="faint">— otherwise they install when you restart or quit</span></span></label>
        <div><Button variant="primary" onClick={save} loading={saving} disabled={JSON.stringify(draft) === JSON.stringify(prefs)}>Save preferences</Button></div>
      </div>
    </Panel>
  )
}

const PROVIDER_LABEL: Record<AiProviderId, string> = { anthropic: 'Anthropic Claude', openai: 'OpenAI' }

/** Which AI provider interprets strategy prompts. The AI only proposes rules; it never places trades. */
function AiAssistantSettings({ views, onOpen }: { views: IntegrationView[]; onOpen: (t: Tab) => void }) {
  const toast = useToast()
  const prefs = useResource(() => call('ai:getPreferences'), [])
  const [choice, setChoice] = useState<AiProviderId | ''>('')
  const [saving, setSaving] = useState(false)
  useEffect(() => setChoice(prefs.data?.preferredProvider ?? ''), [prefs.data])
  const configured = (id: AiProviderId) => views.find((v) => v.id === id && v.state !== 'not_configured')
  const save = async () => {
    setSaving(true)
    try {
      const next: AiPreferences = { preferredProvider: choice || null }
      await call('ai:savePreferences', next)
      await prefs.reload()
      toast({ tone: 'ok', title: 'AI preference saved' })
    } catch (err) {
      toast({ tone: 'bad', title: 'Not saved', body: errorMessage(err) })
    } finally {
      setSaving(false)
    }
  }
  if (!prefs.data) return prefs.error ? <ErrorState message={prefs.error} onRetry={prefs.reload} /> : <Skeleton height={200} />
  const none = !configured('anthropic') && !configured('openai')
  return (
    <Panel title="AI strategy assistant">
      <div className="form" style={{ maxWidth: 640 }}>
        <p className="muted" style={{ margin: 0 }}>
          The AI turns your plain-language strategy prompts into rules for you to review. It never places trades: only strategies you confirm, that pass TradePilot's validation and risk checks, can be run by the trading engine.
        </p>
        {none && <Banner tone="warn" title="No AI provider connected" actions={<Button size="sm" onClick={() => onOpen('anthropic')}>Connect Claude</Button>}>Add an Anthropic Claude or OpenAI API key under Connections to create strategies from prompts.</Banner>}
        <Field label="Preferred provider" hint="Used for new prompts. If it is not connected, the other connected provider is used.">
          <select className="select" value={choice} onChange={(e) => setChoice(e.target.value as AiProviderId | '')}>
            <option value="">Automatic (first connected)</option>
            {(['anthropic', 'openai'] as AiProviderId[]).map((id) => {
              const v = configured(id)
              return <option key={id} value={id}>{PROVIDER_LABEL[id]}{v ? ` · ${String(v.config.model ?? '')}` : ' (not connected)'}</option>
            })}
          </select>
        </Field>
        <dl className="kv">
          {(['anthropic', 'openai'] as AiProviderId[]).map((id) => (
            <span key={id} style={{ display: 'contents' }}>
              <dt>{PROVIDER_LABEL[id]}</dt>
              <dd>{configured(id) ? <Badge tone="ok">connected</Badge> : <Badge>not connected</Badge>} <Button size="sm" variant="ghost" onClick={() => onOpen(id)}>Configure</Button></dd>
            </span>
          ))}
        </dl>
        <div><Button variant="primary" onClick={save} loading={saving} disabled={(prefs.data.preferredProvider ?? '') === choice}>Save</Button></div>
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
        <dt>Live trading</dt><dd><Badge tone="warn">Off unless you enable it on the Trading page</Badge></dd>
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
          {item('ai', 'AI assistant', 'brain')}
          {item('security', 'Security', 'shield')}
          {item('updates', 'Updates', 'download')}
          {item('about', 'About', 'info')}
          <div className="group">Connections</div>
          {(['delta', 'marketdata', 'openai', 'anthropic', 'smtp', 'whatsapp'] as IntegrationId[]).map((id) => item(id, INTEGRATION_META[id].title, INTEGRATION_META[id].icon, toneOf(id) ?? undefined))}
        </nav>
        <div>
          {tab === 'general' && <General />}
          {tab === 'ai' && <AiAssistantSettings views={views} onOpen={setTab} />}
          {tab === 'security' && <Security storage={storage.data} />}
          {tab === 'updates' && <Updates />}
          {tab === 'about' && <About />}
          {tab in INTEGRATION_META && (integrations.error ? <ErrorState message={integrations.error} onRetry={integrations.reload} /> : current ? <IntegrationSection key={current.id} view={current} onChange={() => void integrations.reload()} storageOk={storage.data?.available !== false} /> : <Skeleton height={240} />)}
        </div>
      </div>
    </div>
  )
}
