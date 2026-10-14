import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiProviderId, ChatMessage, InterpretationTurn, Strategy } from '@shared/ipc'
import { diffDefinitions, type StrategyDefinition } from '@shared/strategyRules'
import { Badge, Banner, Button, Field, Panel, Spinner, useToast } from '../../components/ui'
import { call, errorMessage } from '../../lib/api'
import { useResource } from '../../lib/hooks'
import { useApp } from '../../lib/state'
import { ExplanationView, RulesView, ValidationList } from './parts'

/**
 * Prompt-first strategy workspace. The client describes a strategy (or a change) in plain
 * language, the AI proposes rules, TradePilot validates and explains them itself, and nothing
 * is saved until the client confirms. Saved strategies always start (or stay) as they were:
 * nothing here enables or starts trading.
 */
export type StudioMode = { kind: 'create' } | { kind: 'modify'; base: Strategy } | { kind: 'reprompt'; base: Strategy }

type Entry = { role: 'user'; content: string } | { role: 'assistant'; turn: InterpretationTurn }

const PROVIDER_LABEL: Record<AiProviderId, string> = { anthropic: 'Claude', openai: 'OpenAI' }

const EXAMPLES = [
  'Trade BTC when the 15-minute trend is bullish and RSI crosses above 30. Use 2% of my allocated trading capital per trade, set stop-loss at 1.5%, take-profit at 3%, and stop opening new trades after a daily loss of $20.',
  'On the 1-hour chart, buy BTCUSD when the 20 EMA crosses above the 50 EMA and sell when it crosses back below. Risk 1% per trade with a 2× ATR stop, at most 3 trades and 3% loss per day.',
  'Short ETHUSD on the 4-hour chart when the close breaks below the lowest low of the last 20 candles. Stop-loss 2%, take-profit at 2 times the risk, 10% of equity per trade, max 2 trades a day and $50 daily loss.'
]

function userTextOf(entries: Entry[]): string[] {
  return entries.filter((e): e is { role: 'user'; content: string } => e.role === 'user').map((e) => e.content)
}

export function PromptStudio({ mode, onClose, onSaved, onAdvanced }: {
  mode: StudioMode
  onClose: () => void
  onSaved: (s: Strategy) => void
  /** Opens the advanced (manual) builder with the interpreted rules. */
  onAdvanced: (d: StrategyDefinition, provider: AiProviderId, prompt: string) => void
}) {
  const toast = useToast()
  const { navigate } = useApp()
  const base = mode.kind === 'create' ? null : mode.base
  const integrations = useResource(() => call('integrations:list'), [])
  const prefs = useResource(() => call('ai:getPreferences'), [])
  const providers = (integrations.data ?? []).filter((v) => (v.id === 'openai' || v.id === 'anthropic') && v.state !== 'not_configured')
  const preferred = (prefs.data?.preferredProvider && providers.some((p) => p.id === prefs.data!.preferredProvider) ? prefs.data.preferredProvider : (providers.find((p) => p.id === 'anthropic') ?? providers[0])?.id) as AiProviderId | undefined
  const [providerChoice, setProviderChoice] = useState<AiProviderId | ''>('')
  const provider = (providerChoice || preferred || '') as AiProviderId | ''

  const [prompt, setPrompt] = useState(mode.kind === 'reprompt' ? mode.base.prompt ?? '' : '')
  const [entries, setEntries] = useState<Entry[]>([])
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const threadRef = useRef<HTMLDivElement>(null)

  const latest = [...entries].reverse().find((e): e is { role: 'assistant'; turn: InterpretationTurn } => e.role === 'assistant')?.turn
  const submittedPrompt = entries[0]?.role === 'user' ? entries[0].content : null
  const promptEdited = submittedPrompt !== null && prompt.trim() !== submittedPrompt
  const changes = useMemo(() => (base && latest ? diffDefinitions(base.definition, { ...latest.definition, name: name.trim() || latest.definition.name }) : null), [base, latest, name])

  useEffect(() => {
    setConfirmed(false)
    if (latest) setName(latest.definition.name || base?.name || '')
  }, [latest])
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
  }, [entries, busy])

  const run = async (next: Entry[]) => {
    if (!provider) return
    setEntries(next)
    setBusy(true)
    setError(null)
    try {
      const messages: ChatMessage[] = next.map((e) => (e.role === 'user' ? { role: 'user', content: e.content } : { role: 'assistant', content: e.turn.assistantMessage }))
      const turn = await call('ai:interpretStrategy', { provider, messages, ...(mode.kind === 'modify' ? { baseStrategyId: mode.base.id } : {}) })
      setEntries([...next, { role: 'assistant', turn }])
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /** Starts a fresh interpretation from the (possibly revised) prompt; earlier answers are discarded. */
  const interpret = () => {
    const text = prompt.trim()
    if (text.length < 3 || busy) return
    setReply('')
    void run([{ role: 'user', content: text }])
  }
  const answer = () => {
    const text = reply.trim()
    if (text.length < 1 || busy || !entries.length) return
    setReply('')
    void run([...entries, { role: 'user', content: text }])
  }
  const retry = () => void run(entries.at(-1)?.role === 'user' ? entries : entries.slice(0, -1))

  const save = async () => {
    if (!latest) return
    setSaving(true)
    try {
      const texts = userTextOf(entries)
      const full = texts.length > 1 ? `${texts[0]}\n\nClarifications:\n${texts.slice(1).map((t) => `- ${t}`).join('\n')}` : texts[0] ?? ''
      const definition = { ...latest.definition, name: name.trim() }
      const saved =
        mode.kind === 'create'
          ? await call('strategies:save', { definition, source: 'ai', aiProvider: latest.provider, prompt: full })
          : mode.kind === 'reprompt'
            ? await call('strategies:save', { id: mode.base.id, definition, source: 'ai', aiProvider: latest.provider, prompt: full })
            : await call('strategies:save', { id: mode.base.id, definition, source: 'ai', aiProvider: latest.provider, changeRequest: full })
      toast(
        mode.kind === 'create'
          ? { tone: 'ok', title: 'Strategy saved (disabled)', body: `${saved.name}. Backtest it, then enable it when you are ready.` }
          : { tone: 'ok', title: `Saved as version ${saved.version}`, body: saved.status === 'enabled' ? 'Running automations keep their current version until you apply this one.' : saved.name }
      )
      onSaved(saved)
    } catch (err) {
      toast({ tone: 'bad', title: 'Not saved', body: errorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  const ready = latest?.status === 'ready_for_review' && latest.validation.valid
  const nothingChanged = changes !== null && changes.length === 0
  const canSave = ready && confirmed && !promptEdited && !busy && name.trim().length > 0 && !nothingChanged
  const lastIsUser = entries.at(-1)?.role === 'user'
  const title = mode.kind === 'create' ? 'New strategy from a prompt' : mode.kind === 'modify' ? `Change “${mode.base.name}” in plain language` : `Revise the prompt of “${mode.base.name}”`

  if (integrations.data && providers.length === 0) {
    return (
      <div className="page">
        <Panel title={title} actions={<Button size="sm" variant="ghost" onClick={onClose}>Back</Button>}>
          <Banner tone="info" title="Connect an AI provider first" actions={<Button size="sm" onClick={() => navigate('settings', { tab: 'anthropic' })}>Open Settings</Button>}>
            Strategies are written as prompts and interpreted by Anthropic Claude or OpenAI. Add an API key in Settings → Connections. You can still build rules by hand in the advanced builder.
          </Banner>
        </Panel>
      </div>
    )
  }

  return (
    <div className="page">
      <Panel
        title={title}
        actions={<Button size="sm" variant="ghost" disabled={busy || saving} onClick={onClose}>Back</Button>}
      >
        <div className="studio">
          {/* ---------- prompt and conversation ---------- */}
          <div className="studio-input">
            {mode.kind === 'modify' && (
              <div className="studio-context">
                <div className="panel-title">Current version {mode.base.version}</div>
                {mode.base.prompt ? <div className="prompt-quote">{mode.base.prompt}</div> : <div className="faint">Built without a prompt.</div>}
              </div>
            )}
            <Field
              label={mode.kind === 'modify' ? 'What should change?' : 'Describe your strategy'}
              hint={mode.kind === 'modify' ? 'For example: “tighten the stop-loss to 1% and allow at most 2 trades a day”. Everything you do not mention stays the same.' : 'Instrument, timeframe, when to enter and exit, position size, stop-loss and daily limits. The AI asks about anything missing.'}
            >
              <textarea
                className="textarea prompt-editor"
                rows={mode.kind === 'modify' ? 4 : 7}
                maxLength={4000}
                value={prompt}
                disabled={busy || saving}
                placeholder={mode.kind === 'modify' ? 'Describe the change…' : 'Trade BTC on the 15-minute chart when…'}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) interpret()
                }}
              />
            </Field>
            {mode.kind === 'create' && !entries.length && (
              <div className="prompt-examples">
                <span className="faint" style={{ fontSize: 12 }}>Examples:</span>
                {EXAMPLES.map((ex, i) => (
                  <button key={i} type="button" className="chip" onClick={() => setPrompt(ex)} disabled={busy}>{ex.slice(0, 64)}…</button>
                ))}
              </div>
            )}
            <div className="btn-row">
              <Button variant="primary" icon="brain" loading={busy && entries.length <= 1} disabled={!provider || prompt.trim().length < 3 || busy || saving} onClick={interpret}>
                {entries.length ? 'Regenerate from prompt' : 'Interpret prompt'}
              </Button>
              <select className="select" style={{ width: 220 }} value={providerChoice} onChange={(e) => setProviderChoice(e.target.value as AiProviderId | '')} aria-label="AI provider" disabled={busy}>
                <option value="">{preferred ? `Preferred: ${PROVIDER_LABEL[preferred]}` : 'Preferred provider'}</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{PROVIDER_LABEL[p.id as AiProviderId]} · {p.config.model}</option>)}
              </select>
              <span className="faint" style={{ fontSize: 12 }}>Ctrl+Enter</span>
            </div>
            {promptEdited && <Banner tone="warn">The prompt changed since it was interpreted. Regenerate to update the rules; earlier answers are discarded.</Banner>}

            {entries.length > 1 && (
              <div className="studio-thread" ref={threadRef}>
                {entries.slice(1).map((e, i) =>
                  e.role === 'user' ? (
                    <div key={i} className="bubble user">{e.content}</div>
                  ) : (
                    <div key={i} className="bubble ai">
                      <div className="b-label">{PROVIDER_LABEL[e.turn.provider]} · {e.turn.model} · AI output</div>
                      {e.turn.aiSummary || 'No summary.'}
                      {(e.turn.questions.length > 0 || e.turn.missing.length > 0) && (
                        <ul>
                          {e.turn.questions.map((q, j) => <li key={`q${j}`}>{q}</li>)}
                          {e.turn.missing.filter((m) => !e.turn.questions.some((q) => q === m)).map((m, j) => <li key={`m${j}`}>{m} <span className="faint">(TradePilot)</span></li>)}
                        </ul>
                      )}
                    </div>
                  )
                )}
                {busy && <div className="bubble ai"><span className="progress-step"><Spinner />Interpreting with {provider ? PROVIDER_LABEL[provider] : 'AI'}…</span></div>}
              </div>
            )}
            {busy && entries.length <= 1 && <div className="faint"><span className="progress-step"><Spinner />Interpreting with {provider ? PROVIDER_LABEL[provider] : 'AI'}…</span></div>}
            {error && <Banner tone="bad" title="The AI request failed" actions={lastIsUser ? <Button size="sm" onClick={retry}>Retry</Button> : undefined}>{error}</Banner>}

            {latest && latest.status !== 'ready_for_review' && !busy && (
              <div className="studio-answer">
                <Field label="Answer the questions" hint="Or revise the prompt above and regenerate.">
                  <textarea
                    className="textarea"
                    rows={3}
                    maxLength={4000}
                    value={reply}
                    placeholder="For example: trend = close above the 50-period EMA; allocated capital $1,000; at most 3 trades a day."
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) answer()
                    }}
                  />
                </Field>
                <div><Button icon="chat" disabled={reply.trim().length < 1 || promptEdited} onClick={answer}>Send answer</Button></div>
              </div>
            )}
          </div>

          {/* ---------- review ---------- */}
          <div className="studio-review">
            {!latest ? (
              <div className="studio-empty">
                <div className="panel-title">How it works</div>
                <ol>
                  <li>Write the strategy (or the change) in your own words.</li>
                  <li>The AI proposes rules and asks about anything missing or unclear.</li>
                  <li>TradePilot validates the rules against what it can actually execute, explains them in plain language, and flags anything it cannot implement instead of quietly changing it.</li>
                  <li>You review and confirm. Saved strategies start disabled; backtest them, then enable and run them in paper trading first.</li>
                </ol>
                <div className="faint" style={{ fontSize: 12 }}>The AI never places trades. Only confirmed, validated strategies can be run, and the engine applies its own risk limits to every order.</div>
              </div>
            ) : (
              <>
                <Banner
                  tone={ready ? 'ok' : latest.status === 'unsupported' ? 'bad' : 'warn'}
                  title={ready ? 'Ready for your review' : latest.status === 'unsupported' ? 'This cannot be implemented' : 'More information needed'}
                >
                  {ready ? 'Check every rule below. The explanation is written by TradePilot from the rules themselves, not by the AI.' : latest.status === 'unsupported' ? 'Nothing in the request can be expressed with the available rules. See why below.' : 'Answer the questions on the left or revise the prompt. The rules cannot be saved until everything required is defined and valid.'}
                </Banner>

                {latest.unsupported.length > 0 && (
                  <div className="review-block bad">
                    <div className="panel-title">Cannot be implemented</div>
                    <ul>{latest.unsupported.map((u, i) => <li key={i}>{u}</li>)}</ul>
                    <div className="faint" style={{ fontSize: 12 }}>TradePilot does not replace these with something similar. Remove or rephrase them, or accept that they are not part of the rules below.</div>
                  </div>
                )}
                {latest.ambiguities.length > 0 && (
                  <div className="review-block warn">
                    <div className="panel-title">Unclear</div>
                    <ul>{latest.ambiguities.map((u, i) => <li key={i}>{u}</li>)}</ul>
                  </div>
                )}
                {latest.missing.length > 0 && (
                  <div className="review-block warn">
                    <div className="panel-title">Still required <span className="faint">(checked by TradePilot)</span></div>
                    <ul>{latest.missing.map((u, i) => <li key={i}>{u}</li>)}</ul>
                  </div>
                )}

                {changes && (
                  <div className="review-block">
                    <div className="panel-title">Changes from version {base!.version}</div>
                    {changes.length === 0 ? <div className="faint">No rule changes.</div> : (
                      <table className="data compact">
                        <thead><tr><th>What</th><th>Before</th><th>After</th></tr></thead>
                        <tbody>{changes.map((c) => <tr key={c.field}><td className="nowrap">{c.field}</td><td className="faint">{c.before}</td><td>{c.after}</td></tr>)}</tbody>
                      </table>
                    )}
                    {base!.status === 'enabled' && <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Saving creates version {base!.version + 1}. A running automation, and any position it holds, keeps version {base!.version} until you apply the new version on the Trading page while it has no open position.</div>}
                  </div>
                )}

                <div className="review-block">
                  <div className="panel-title">How it would trade</div>
                  <ExplanationView d={latest.definition} />
                </div>
                <div className="review-block">
                  <div className="panel-title">Interpreted rules</div>
                  <RulesView d={latest.definition} />
                </div>
                <div className="review-block">
                  <div className="panel-title">Validation</div>
                  <ValidationList v={latest.validation} />
                </div>
                {latest.aiSummary && (
                  <div className="review-block">
                    <div className="panel-title">The AI's summary <Badge>AI output</Badge></div>
                    <div className="muted">{latest.aiSummary}</div>
                  </div>
                )}

                <div className="review-block confirm">
                  <Field label="Strategy name">
                    <input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} disabled={!ready} />
                  </Field>
                  <label className="check">
                    <input type="checkbox" checked={confirmed} disabled={!ready || promptEdited} onChange={(e) => setConfirmed(e.target.checked)} />
                    <span>I reviewed these rules. I understand they were interpreted by AI, are not verified trading logic, and should be backtested and paper traded before live use.</span>
                  </label>
                  <div className="btn-row">
                    <Button variant="primary" icon="check" loading={saving} disabled={!canSave || saving} onClick={() => void save()}>
                      {mode.kind === 'create' ? 'Confirm and save' : `Confirm and save as version ${base!.version + 1}`}
                    </Button>
                    {provider && <Button variant="ghost" icon="sliders" disabled={saving || busy} onClick={() => onAdvanced({ ...latest.definition, name: name.trim() || latest.definition.name }, latest.provider, userTextOf(entries).join('\n\n'))}>Advanced editor</Button>}
                  </div>
                  <span className="faint" style={{ fontSize: 12 }}>
                    {nothingChanged ? 'Nothing changed compared with the current version.' : mode.kind === 'create' ? 'Saved strategies start disabled. Nothing is traded until you enable the strategy and start paper or live automation yourself.' : 'Saving never starts, stops or changes live trading.'}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </Panel>
    </div>
  )
}
