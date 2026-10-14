import { useState } from 'react'
import { AuthScreen, ForcedPasswordChange } from './pages/Auth'
import { Shell } from './Shell'
import { Spinner } from './components/ui'
import { Welcome } from './components/Welcome'
import { useApp } from './lib/state'

export function App() {
  const { auth, info } = useApp()
  // the welcome screen plays once per launch, before sign-in
  const [welcomed, setWelcomed] = useState(false)
  if (!auth || !info) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
        <Spinner />
      </div>
    )
  }
  if (!welcomed) return <Welcome sound={info.welcomeSound} onDone={() => setWelcomed(true)} />
  if (auth.state !== 'unlocked') return <AuthScreen />
  if (auth.mustChangePassword) return <ForcedPasswordChange />
  return <Shell />
}
