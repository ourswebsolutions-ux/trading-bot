import { useEffect, useRef, useState } from 'react'
import type { CandleSeries, MarketSnapshot, Timeframe } from '@shared/ipc'
import { call, errorMessage } from './api'
import { useEvent } from './hooks'

/** Registers what a view displays with the main-process market service and follows live updates. */
export function useMarketWatch(view: string, symbols: string[], chart?: { symbol: string; timeframe: Timeframe } | null) {
  const [snap, setSnap] = useState<MarketSnapshot | null>(null)
  const key = `${symbols.join(',')}|${chart?.symbol ?? ''}|${chart?.timeframe ?? ''}`
  useEffect(() => {
    let cancelled = false
    void call('market:watch', { view, symbols, chart: chart ?? null })
      .then((s) => !cancelled && setSnap(s))
      .catch(() => undefined)
    return () => {
      cancelled = true
      void call('market:unwatch', { view }).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, key])
  useEvent('market:changed', setSnap)
  return snap
}

/**
 * Historical candles from REST plus live candle updates from the stream. Refetches when the
 * stream reconnects (connectionEpoch changes) so candles missed during an outage are backfilled.
 */
export function useLiveSeries(symbol: string, timeframe: Timeframe, days: number, epoch: number | undefined) {
  const [series, setSeries] = useState<CandleSeries | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [liveAt, setLiveAt] = useState<string | null>(null)
  const current = useRef({ symbol, timeframe })
  current.current = { symbol, timeframe }

  useEffect(() => {
    let cancelled = false
    setError(null)
    void call('market:series', { symbol, timeframe, days })
      .then((s) => {
        if (!cancelled) setSeries(s)
      })
      .catch((err) => !cancelled && setError(errorMessage(err)))
    return () => {
      cancelled = true
    }
  }, [symbol, timeframe, days, epoch])

  useEvent('market:candle', (u) => {
    if (u.symbol !== current.current.symbol || u.timeframe !== current.current.timeframe) return
    setLiveAt(u.receivedAt)
    setSeries((s) => {
      if (!s || s.symbol !== u.symbol || s.timeframe !== u.timeframe) return s
      const candles = s.candles.slice()
      const last = candles.at(-1)
      if (last && last.time === u.candle.time) candles[candles.length - 1] = u.candle
      else if (!last || u.candle.time > last.time) candles.push(u.candle)
      else return s // older than what we have: ignore
      return { ...s, candles }
    })
  })

  const reload = () => {
    setError(null)
    void call('market:series', { symbol, timeframe, days }).then(setSeries).catch((err) => setError(errorMessage(err)))
  }
  return { series: series && series.symbol === symbol && series.timeframe === timeframe ? series : null, error, liveAt, reload }
}
