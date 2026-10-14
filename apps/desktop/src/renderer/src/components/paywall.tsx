import { useApp } from '../lib/state'
import { Banner, Button } from './ui'

/** True when paid features may be used (decided by the main process from the server-signed status). */
export function useAccess(): { allowed: boolean; detail: string } {
  const { subscription } = useApp()
  return { allowed: Boolean(subscription?.access.allowed), detail: subscription?.access.detail ?? 'Checking your subscription…' }
}

export function PaywallBanner({ feature }: { feature: string }) {
  const { navigate } = useApp()
  const { allowed, detail } = useAccess()
  if (allowed) return null
  return (
    <Banner
      tone="warn"
      icon="lock"
      title={`${feature} needs an active trial or subscription`}
      actions={<Button size="sm" variant="primary" onClick={() => navigate('subscription')}>View plans</Button>}
    >
      {detail} Your saved data is kept and becomes available again as soon as access is restored.
    </Banner>
  )
}
