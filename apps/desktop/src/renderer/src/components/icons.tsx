import type { SVGProps } from 'react'

/** Hand-drawn 16px stroke icon set (1.5px strokes on a 16 grid). */
const paths: Record<string, string> = {
  dashboard: 'M2.5 2.5h4.5v5.5H2.5zM9 2.5h4.5v3H9zM9 7.5h4.5v6H9zM2.5 10h4.5v3.5H2.5z',
  strategies: 'M3 13.5V9M6.5 13.5V5M10 13.5V7.5M13.5 13.5V2.5M2 13.5h12',
  trading: 'M2 11l3.5-3.5 3 3L14 5M10.5 5H14v3.5',
  analytics: 'M2.5 13.5h11M4 11V8M7 11V4.5M10 11V6.5M13 11V2.5',
  bell: 'M4 11V7a4 4 0 018 0v4l1.2 1.5H2.8zM6.5 14h3',
  card: 'M2 4h12v8.5H2zM2 6.5h12M4.5 10h3',
  settings: 'M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM8 1.8v1.7M8 12.5v1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M1.8 8h1.7M12.5 8h1.7M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2',
  lock: 'M4 7V5a4 4 0 018 0v2M3 7h10v6.5H3zM8 9.5v1.5',
  logout: 'M6 2.5H3v11h3M10 5l3 3-3 3M13 8H6.5',
  refresh: 'M13.5 8A5.5 5.5 0 113 5.2M3 2v3.2h3.2',
  plus: 'M8 3v10M3 8h10',
  check: 'M3 8.5l3 3 7-7',
  x: 'M4 4l8 8M12 4l-8 8',
  alert: 'M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5v.5',
  info: 'M8 1.8a6.2 6.2 0 100 12.4A6.2 6.2 0 008 1.8zM8 7v4.5M8 4.8v.4',
  download: 'M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10',
  upload: 'M8 11V3M4.5 6.5L8 3l3.5 3.5M3 13.5h10',
  copy: 'M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3',
  play: 'M5 3.5l8 4.5-8 4.5z',
  archive: 'M2 3h12v3H2zM3 6v7.5h10V6M6.5 9h3',
  trash: 'M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 9h5.6l.7-9',
  edit: 'M10.5 2.5l3 3L6 13H3v-3z',
  folder: 'M2 4.5h4.5L8 6h6v7.5H2z',
  shield: 'M8 1.8l5 2v4c0 3.2-2.2 5.2-5 6.4-2.8-1.2-5-3.2-5-6.4v-4z',
  server: 'M2.5 3h11v4h-11zM2.5 9h11v4h-11zM5 5h.5M5 11h.5',
  cpu: 'M4.5 4.5h7v7h-7zM6.5 6.5h3v3h-3zM6 2v2.5M10 2v2.5M6 11.5V14M10 11.5V14M2 6h2.5M2 10h2.5M11.5 6H14M11.5 10H14',
  key: 'M10 2.5a3.5 3.5 0 11-2.9 5.4L2.5 12.5V14H5v-1.5h1.5V11l2-2',
  mail: 'M2 3.5h12v9H2zM2 4l6 5 6-5',
  chat: 'M2.5 3h11v8h-6l-3 2.5V11h-2z',
  brain: 'M8 3.5v9M5.5 3a2.5 2.5 0 00-2.5 2.5c-1 .6-1 2.4 0 3-.4 1.6.8 3.5 2.5 3.5M10.5 3A2.5 2.5 0 0113 5.5c1 .6 1 2.4 0 3 .4 1.6-.8 3.5-2.5 3.5',
  exchange: 'M2.5 5.5h10L10 3M13.5 10.5h-10L6 13',
  clock: 'M8 1.8a6.2 6.2 0 100 12.4A6.2 6.2 0 008 1.8zM8 4.5V8l2.5 1.5',
  restore: 'M3 8a5 5 0 109-3M3 3v3h3',
  external: 'M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4',
  sliders: 'M3 2.5v11M8 2.5v11M13 2.5v11M1.5 10h3M6.5 5h3M11.5 9h3',
  user: 'M8 2.5a2.75 2.75 0 100 5.5 2.75 2.75 0 000-5.5zM2.5 13.5c.8-2.3 3-3.5 5.5-3.5s4.7 1.2 5.5 3.5'
}

export type IconName = keyof typeof paths

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d={paths[name]} />
    </svg>
  )
}

/** Brand mark: an instrument needle over a price trace. */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <rect x="0.75" y="0.75" width="26.5" height="26.5" rx="7" fill="var(--surface-3)" stroke="var(--line-strong)" strokeWidth="1.5" />
      <path d="M5 18.5l4.2-4.4 3.4 2.6 4.6-6.2 2.6 2.2L23 8.5" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="23" cy="8.5" r="1.8" fill="var(--accent)" />
    </svg>
  )
}
