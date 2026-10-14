import { AuthScreen, ForcedPasswordChange } from './pages/Auth'
import { Shell } from './Shell'
import { Spinner } from './components/ui'
import { useApp } from './lib/state'

export function App() {
  const { auth } = useApp()
  if (!auth) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
        <Spinner />
      </div>
    )
  }
  if (auth.state !== 'unlocked') return <AuthScreen />
  if (auth.mustChangePassword) return <ForcedPasswordChange />
  return <Shell />
}
