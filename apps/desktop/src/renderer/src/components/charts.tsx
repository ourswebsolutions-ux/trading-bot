import { useEffect, useMemo, useRef, useState } from 'react'
import type { Candle } from '@shared/ipc'
import { price as fmtPrice } from '../lib/format'

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

/** "Nice" axis ticks (1/2/5 × 10^n). */
function ticks(min: number, max: number, count: number): number[] {
  if (!(max > min)) return [min]
  const raw = (max - min) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(+v.toPrecision(12))
  return out
}

function timeLabel(t: number, spanSec: number): string {
  const d = new Date(t * 1000)
  if (spanSec <= 3 * 86400) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

export interface ChartMarker {
  time: number
  price: number
  kind: 'entry-long' | 'entry-short' | 'exit'
}

const PAD = { l: 8, r: 64, t: 10, b: 22 }

export function CandleChart({ candles, height = 300, markers = [] }: { candles: Candle[]; height?: number; markers?: ChartMarker[] }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const view = useMemo(() => {
    const plotW = Math.max(0, width - PAD.l - PAD.r)
    // keep candles legible: show at most one per 3px
    const maxBars = Math.max(10, Math.floor(plotW / 3))
    const data = candles.slice(-maxBars)
    if (!data.length || plotW <= 0) return null
    const lo = Math.min(...data.map((c) => c.low))
    const hi = Math.max(...data.map((c) => c.high))
    const padY = (hi - lo) * 0.06 || hi * 0.01
    const yMin = lo - padY
    const yMax = hi + padY
    const plotH = height - PAD.t - PAD.b
    const bw = plotW / data.length
    const x = (i: number) => PAD.l + i * bw + bw / 2
    const y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * plotH
    return { data, bw, x, y, yTicks: ticks(yMin, yMax, 5), plotW, plotH, span: data.at(-1)!.time - data[0]!.time }
  }, [candles, width, height])

  if (!view) return <div ref={ref} className="chart" style={{ height }} />
  const { data, bw, x, y, yTicks, span } = view
  const xTickEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(view.plotW / 110))))
  const hc = hover !== null ? data[hover] : null
  const last = data.at(-1)!
  const lastUp = last.close >= last.open
  const index = new Map(data.map((c, i) => [c.time, i]))

  return (
    <div ref={ref} className="chart" style={{ height }}>
      <svg
        height={height}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const i = Math.floor((e.clientX - rect.left - PAD.l) / bw)
          setHover(i >= 0 && i < data.length ? i : null)
        }}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Price chart, last close ${fmtPrice(last.close)}`}
      >
        <g className="grid">
          {yTicks.map((t) => <line key={t} x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} />)}
        </g>
        <g className="axis">
          {yTicks.map((t) => <text key={t} x={width - PAD.r + 8} y={y(t) + 3.5}>{fmtPrice(t)}</text>)}
          {data.map((c, i) => (i % xTickEvery === 0 ? <text key={c.time} x={x(i)} y={height - 6} textAnchor="middle">{timeLabel(c.time, span)}</text> : null))}
        </g>
        {data.map((c, i) => {
          const up = c.close >= c.open
          const color = up ? 'var(--up)' : 'var(--down)'
          const top = y(Math.max(c.open, c.close))
          const h = Math.max(1, Math.abs(y(c.open) - y(c.close)))
          const w = Math.max(1, bw * 0.62)
          return (
            <g key={c.time}>
              <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth={1} />
              <rect x={x(i) - w / 2} y={top} width={w} height={h} fill={up ? 'var(--up)' : 'var(--down)'} opacity={up ? 0.9 : 1} />
            </g>
          )
        })}
        {markers.map((m, k) => {
          const i = index.get(m.time)
          if (i === undefined) return null
          const cx = x(i)
          const cy = y(m.price)
          if (m.kind === 'exit') return <circle key={k} cx={cx} cy={cy} r={3.5} fill="var(--surface)" stroke="var(--text)" strokeWidth={1.5} />
          const long = m.kind === 'entry-long'
          const d = long ? `M${cx} ${cy + 3} l-5 9 h10 z` : `M${cx} ${cy - 3} l-5 -9 h10 z`
          return <path key={k} d={d} fill={long ? 'var(--up)' : 'var(--down)'} stroke="var(--surface)" strokeWidth={1} />
        })}
        <g>
          <line x1={PAD.l} x2={width - PAD.r} y1={y(last.close)} y2={y(last.close)} stroke={lastUp ? 'var(--up)' : 'var(--down)'} strokeDasharray="2 3" opacity={0.7} />
          <rect x={width - PAD.r + 2} y={y(last.close) - 9} width={PAD.r - 4} height={18} rx={3} fill={lastUp ? 'var(--up)' : 'var(--down)'} />
          <text x={width - PAD.r + 8} y={y(last.close) + 4} fill="#fff" style={{ font: "500 10.5px 'IBM Plex Mono', monospace" }}>{fmtPrice(last.close)}</text>
        </g>
        {hc && hover !== null && (
          <g className="crosshair">
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={height - PAD.b} />
          </g>
        )}
      </svg>
      {hc && hover !== null && (
        <div className="chart-tip" style={{ left: Math.min(x(hover) + 12, width - 210), top: 8 }}>
          {new Date(hc.time * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
          <br />O {fmtPrice(hc.open)} H {fmtPrice(hc.high)}
          <br />L {fmtPrice(hc.low)} C <span className={hc.close >= hc.open ? 'up' : 'down'}>{fmtPrice(hc.close)}</span>
        </div>
      )}
    </div>
  )
}

export function LineChart({ points, height = 220, format = (v: number) => v.toFixed(2), baseline }: { points: [number, number][]; height?: number; format?: (v: number) => string; baseline?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  if (points.length < 2 || width === 0) return <div ref={ref} className="chart" style={{ height }} />
  const vals = points.map((p) => p[1])
  const lo = Math.min(...vals, baseline ?? Infinity)
  const hi = Math.max(...vals, baseline ?? -Infinity)
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1
  const yMin = lo - pad
  const yMax = hi + pad
  const plotW = width - PAD.l - PAD.r
  const plotH = height - PAD.t - PAD.b
  const t0 = points[0]![0]
  const t1 = points.at(-1)![0]
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0 || 1)) * plotW
  const y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * plotH
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join('')
  const area = `${path}L${x(t1)} ${height - PAD.b}L${x(t0)} ${height - PAD.b}Z`
  const up = vals.at(-1)! >= (baseline ?? vals[0]!)
  const color = up ? 'var(--up)' : 'var(--down)'
  const yTicks = ticks(yMin, yMax, 4)
  const step = Math.max(1, Math.floor(points.length / Math.max(2, Math.floor(plotW / 120))))
  const hp = hover !== null ? points[hover] : null
  return (
    <div ref={ref} className="chart" style={{ height }}>
      <svg
        height={height}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const t = t0 + ((e.clientX - rect.left - PAD.l) / plotW) * (t1 - t0)
          let best = 0
          for (let i = 1; i < points.length; i++) if (Math.abs(points[i]![0] - t) < Math.abs(points[best]![0] - t)) best = i
          setHover(best)
        }}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Line chart ending at ${format(vals.at(-1)!)}`}
      >
        <defs>
          <linearGradient id="lc-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.22" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="grid">{yTicks.map((t) => <line key={t} x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} />)}</g>
        <g className="axis">
          {yTicks.map((t) => <text key={t} x={width - PAD.r + 8} y={y(t) + 3.5}>{format(t)}</text>)}
          {points.map((p, i) => (i % step === 0 ? <text key={i} x={x(p[0])} y={height - 6} textAnchor="middle">{timeLabel(p[0], t1 - t0)}</text> : null))}
        </g>
        {baseline !== undefined && <line x1={PAD.l} x2={width - PAD.r} y1={y(baseline)} y2={y(baseline)} stroke="var(--text-3)" strokeDasharray="3 4" />}
        <path d={area} fill="url(#lc-fill)" />
        <path d={path} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
        {hp && (
          <g className="crosshair">
            <line x1={x(hp[0])} x2={x(hp[0])} y1={PAD.t} y2={height - PAD.b} />
            <circle cx={x(hp[0])} cy={y(hp[1])} r={3.5} fill={color} stroke="var(--surface)" strokeWidth={1.5} />
          </g>
        )}
      </svg>
      {hp && (
        <div className="chart-tip" style={{ left: Math.min(x(hp[0]) + 12, width - 180), top: 8 }}>
          {new Date(hp[0] * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
          <br />
          {format(hp[1])}
        </div>
      )}
    </div>
  )
}
