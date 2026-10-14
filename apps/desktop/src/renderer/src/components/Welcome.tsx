import { useEffect, useRef } from 'react'
import { BrandMark } from './icons'

/**
 * A warm, rising chord synthesized with the Web Audio API (no audio files): soft attack,
 * gentle bell harmonics and a long tail, about 3 seconds.
 */
function playChime(): () => void {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return () => {}
  const ctx = new Ctx()
  const master = ctx.createGain()
  master.gain.value = 0.0001
  master.connect(ctx.destination)
  // soft room: a short feedback delay
  const delay = ctx.createDelay()
  delay.delayTime.value = 0.18
  const fb = ctx.createGain()
  fb.gain.value = 0.28
  delay.connect(fb).connect(delay)
  delay.connect(master)
  const t0 = ctx.currentTime + 0.05
  master.gain.exponentialRampToValueAtTime(0.32, t0 + 0.08)
  master.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.6)
  // Cmaj9 arpeggio rising into a sustained chord
  const notes = [261.63, 329.63, 392.0, 493.88, 587.33, 783.99]
  notes.forEach((f, i) => {
    const start = t0 + i * 0.11
    for (const [mult, level, type] of [[1, 0.5, 'sine'], [2, 0.12, 'sine'], [3, 0.05, 'triangle']] as const) {
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = type
      osc.frequency.value = f * mult
      g.gain.setValueAtTime(0.0001, start)
      g.gain.exponentialRampToValueAtTime(level / (1 + i * 0.15), start + 0.03)
      g.gain.exponentialRampToValueAtTime(0.0001, start + 2.8 - i * 0.12)
      osc.connect(g)
      g.connect(master)
      g.connect(delay)
      osc.start(start)
      osc.stop(start + 3)
    }
  })
  return () => {
    void ctx.close().catch(() => undefined)
  }
}

export function Welcome({ sound, onDone }: { sound: boolean; onDone: () => void }) {
  const done = useRef(false)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  useEffect(() => {
    const stopSound = sound ? playChime() : () => {}
    const finish = () => {
      if (done.current) return
      done.current = true
      onDoneRef.current()
    }
    const t = setTimeout(finish, 5000)
    const key = (e: KeyboardEvent) => (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') && finish()
    window.addEventListener('keydown', key)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', key)
      setTimeout(stopSound, 3500)
    }
    // runs once per mount: re-renders must not restart the timer or replay the sound
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // deterministic market-like trace for the backdrop (decorative)
  const pts: string[] = []
  let v = 300
  for (let i = 0; i <= 90; i++) {
    v += Math.sin(i * 0.42) * 16 + Math.cos(i * 0.17) * 10 - 3.4
    pts.push(`${(i * 1600) / 90},${v.toFixed(1)}`)
  }
  return (
    <div className="welcome" role="dialog" aria-label="Welcome to TradePilot" onClick={() => {
        if (done.current) return
        done.current = true
        onDoneRef.current()
      }}>
      <svg className="welcome-trace" viewBox="0 0 1600 420" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="wfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path className="area" d={`M0,420 L${pts.join(' L')} L1600,420 Z`} />
        <path className="line" d={`M${pts.join(' L')}`} />
      </svg>
      <div className="welcome-card">
        <span className="welcome-mark"><BrandMark size={88} /></span>
        <h1>TradePilot</h1>
        <p>Rule-based trading, research and automation</p>
        <div className="welcome-bar"><i /></div>
      </div>
      <span className="welcome-skip">Click or press Enter to skip</span>
    </div>
  )
}
