/** Minimal auto-escaping HTML templating. Interpolations are escaped unless wrapped in raw(). */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value
  }
}

export const raw = (value: string): SafeHtml => new SafeHtml(value)

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

type Value = SafeHtml | string | number | null | undefined | false | Value[]

function render(v: Value): string {
  if (v === null || v === undefined || v === false) return ''
  if (Array.isArray(v)) return v.map(render).join('')
  if (v instanceof SafeHtml) return v.value
  return escapeHtml(v)
}

export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let out = strings[0] ?? ''
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? '')
  })
  return new SafeHtml(out)
}
