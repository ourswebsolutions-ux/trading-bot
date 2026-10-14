import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Icon, type IconName } from './icons'

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'danger' | 'ghost' | 'buy' | 'sell' | 'default'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  icon?: IconName
  block?: boolean
}
export function Button({ variant = 'default', size = 'md', loading, icon, block, children, disabled, className = '', ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`btn ${variant !== 'default' ? variant : ''} ${size !== 'md' ? size : ''} ${block ? 'block' : ''} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </button>
  )
}

export function Panel({ title, actions, children, flush, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-head">
          {title && <h2 className="panel-title" style={{ margin: 0 }}>{title}</h2>}
          <div className="spacer" />
          {actions}
        </header>
      )}
      <div className={`panel-body ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  )
}

export function Field({ label, hint, error, children, aside, group }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; aside?: ReactNode; group?: boolean }) {
  const id = useId()
  const describedBy = error || hint ? `${id}-desc` : undefined
  const description = error ? <span id={describedBy} className="f-error" role="alert">{error}</span> : hint ? <span id={describedBy} className="f-hint">{hint}</span> : null
  const labelText = (
    <span className="f-label" id={`${id}-label`}>
      <span>{label}</span>
      {aside}
    </span>
  )
  // Non-input content (buttons, previews) is a labelled group rather than being nested in a <label>.
  if (group) {
    return (
      <div className="field" role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
        {labelText}
        {children}
        {description}
      </div>
    )
  }
  // Hints and errors sit outside the <label> so they don't become part of the control's accessible name.
  const control = isValidElement<{ 'aria-describedby'?: string; 'aria-invalid'?: boolean }>(children)
    ? cloneElement(children, { 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })
    : children
  return (
    <div className="field">
      <label className="field-label">
        {labelText}
        {control}
      </label>
      {description}
    </div>
  )
}

export function Badge({ tone, children }: { tone?: 'ok' | 'bad' | 'warn' | 'info' | 'accent'; children: ReactNode }) {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>
}

export function Empty({ icon = 'info', title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={22} />
      <div className="e-title">{title}</div>
      {children && <div className="e-text">{children}</div>}
      {action}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="empty">
      <Icon name="alert" size={22} style={{ color: 'var(--down)' }} />
      <div className="e-title">Could not load</div>
      <div className="e-text">{message}</div>
      {onRetry && <Button size="sm" icon="refresh" onClick={onRetry}>Try again</Button>}
    </div>
  )
}

export function Banner({ tone = 'info', title, children, actions, icon }: { tone?: 'info' | 'warn' | 'bad' | 'ok'; title?: ReactNode; children?: ReactNode; actions?: ReactNode; icon?: IconName }) {
  const defaultIcon: IconName = tone === 'ok' ? 'check' : tone === 'info' ? 'info' : 'alert'
  return (
    <div className={`banner ${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon name={icon ?? defaultIcon} style={{ marginTop: 1, flex: 'none' }} />
      <div>
        {title && <div className="b-title">{title}</div>}
        {children && <div className={title ? 'muted' : ''}>{children}</div>}
      </div>
      {actions && <div className="b-actions">{actions}</div>}
    </div>
  )
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange, className = '' }: { value: T; options: { value: T; label: string; className?: string }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={`seg ${className}`} role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={`${value === o.value ? 'on' : ''} ${o.className ?? ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={value === t.value ? 'on' : ''} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Dialog({ title, children, footer, onClose, wide }: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button.primary, button.danger, button')
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab' && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>('input, textarea, select, button:not(:disabled), [tabindex="0"]')]
        if (!items.length) return
        const [a, b] = [items[0]!, items[items.length - 1]!]
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault()
          b.focus()
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault()
          a.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      prev?.focus()
    }
  }, [onClose])
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="dialog-head"><h2>{title}</h2></div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  )
}

/** Confirmation dialog whose confirm button stays busy until the action really finishes. */
export function ConfirmDialog({
  title, children, confirmLabel, tone = 'primary', onConfirm, onClose, confirmDisabled
}: {
  title: string; children: ReactNode; confirmLabel: string; tone?: 'primary' | 'danger'; onConfirm: () => Promise<unknown> | void; onClose: () => void; confirmDisabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      await onConfirm()
      onClose()
    } catch {
      // the caller already surfaced the error; keep the dialog open so the user can retry
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={title}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={tone} onClick={run} loading={busy} disabled={confirmDisabled}>{confirmLabel}</Button>
        </>
      }
    >
      {children}
    </Dialog>
  )
}

// ---------- toasts ----------
interface Toast { id: number; tone: 'ok' | 'bad' | 'info'; title: string; body?: string }
const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random()
    setToasts((all) => [...all.slice(-2), { ...t, id }])
    setTimeout(() => dismiss(id), t.tone === 'bad' ? 8000 : 4000)
  }, [dismiss])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <Icon name={t.tone === 'ok' ? 'check' : t.tone === 'bad' ? 'alert' : 'info'} style={{ color: t.tone === 'ok' ? 'var(--up)' : t.tone === 'bad' ? 'var(--down)' : 'var(--info)' }} />
            <div>
              <div className="t-title">{t.title}</div>
              {t.body && <div className="t-body">{t.body}</div>}
            </div>
            <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => dismiss(t.id)} aria-label="Dismiss"><Icon name="x" size={12} /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

/** Password field with a show/hide toggle. Revealing only affects what is typed here; stored secrets are never shown. */
export function PasswordInput({ invalid, className = '', ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  const [shown, setShown] = useState(false)
  return (
    <span className="pw-wrap">
      <input {...rest} type={shown ? 'text' : 'password'} className={`input ${invalid ? 'invalid' : ''} ${className}`} spellCheck={false} autoCapitalize="off" />
      <button type="button" className="pw-eye" onClick={() => setShown((v) => !v)} aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown} tabIndex={-1} disabled={rest.disabled}>
        <Icon name={shown ? 'eyeOff' : 'eye'} size={15} />
      </button>
    </span>
  )
}

export function Skeleton({ height = 14, width = '100%' }: { height?: number; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} />
}

export function StatusDot({ tone }: { tone?: 'ok' | 'bad' | 'warn' | 'info' }) {
  return <span className={`dot ${tone ?? ''}`} />
}
