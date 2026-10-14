import { useCallback, useEffect, useRef, useState } from 'react'
import type { EventContract, EventName } from '@shared/ipc'
import { errorMessage, subscribe } from './api'

export interface Resource<T> {
  data: T | undefined
  error: string | null
  loading: boolean
  reload: () => Promise<void>
}

/** Loads data via an async function; keeps previous data while reloading so screens don't flash. */
export function useResource<T>(fn: () => Promise<T>, deps: unknown[] = [], opts: { pollMs?: number; enabled?: boolean } = {}): Resource<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(opts.enabled !== false)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const seq = useRef(0)

  const reload = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    try {
      const result = await fnRef.current()
      if (mine === seq.current) {
        setData(result)
        setError(null)
      }
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err))
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (opts.enabled === false) return
    void reload()
    if (!opts.pollMs) return
    const t = setInterval(() => void reload(), opts.pollMs)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, opts.enabled, opts.pollMs])

  return { data, error, loading, reload }
}

export function useEvent<E extends EventName>(event: E, fn: (payload: EventContract[E]) => void) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => subscribe(event, (p) => ref.current(p)), [event])
}

/** Wraps an async action with pending state; returns [run, pending]. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): [(...args: A) => Promise<R | undefined>, boolean] {
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const run = useCallback(
    async (...args: A) => {
      if (busy.current) return undefined // ignore double-clicks while in flight
      busy.current = true
      setPending(true)
      try {
        return await fn(...args)
      } finally {
        busy.current = false
        setPending(false)
      }
    },
    [fn]
  )
  return [run, pending]
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
