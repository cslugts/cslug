/**
 * ICU message format, the subset apps use: `{name}` arguments, `plural` (with `=N` and `#`) and `select`.
 * Pure (no Node APIs), so it runs on the server (core's Translator) and in the browser (island `useT`).
 */
export type Part =
  | string
  | { arg: string }
  | { arg: string; kind: 'plural' | 'select'; options: Record<string, Part[]> }

function parse(message: string): Part[] {
  let i = 0
  const parseParts = (inPlural: boolean, untilBrace: boolean): Part[] => {
    const parts: Part[] = []
    let text = ''
    const flush = () => {
      if (text) parts.push(text)
      text = ''
    }
    while (i < message.length) {
      const ch = message[i] as string
      if (ch === '}' && untilBrace) break
      if (ch === '#' && inPlural) {
        flush()
        parts.push({ arg: '#' })
        i++
      } else if (ch === '{') {
        flush()
        i++
        parts.push(parseArgument())
      } else {
        text += ch
        i++
      }
    }
    flush()
    return parts
  }
  const parseArgument = (): Part => {
    const close = message.indexOf('}', i)
    const header = message.slice(i, close === -1 ? undefined : close)
    const [name, kind] = header.split(',').map((s) => s.trim())
    if (kind !== 'plural' && kind !== 'select') {
      i = close + 1
      return { arg: name as string }
    }
    i = message.indexOf(',', message.indexOf(',', i) + 1) + 1 // after "name, kind,"
    const options: Record<string, Part[]> = {}
    while (i < message.length && message[i] !== '}') {
      const open = message.indexOf('{', i)
      const key = message.slice(i, open).trim()
      i = open + 1
      options[key] = parseParts(kind === 'plural', true)
      i++ // past the option's closing brace
      while (message[i] === ' ' || message[i] === '\n') i++
    }
    i++ // past the argument's closing brace
    return { arg: name as string, kind, options }
  }
  return parseParts(false, false)
}

function render(parts: Part[], params: Record<string, unknown>, locale: string, hash?: number): string {
  let out = ''
  for (const p of parts) {
    if (typeof p === 'string') out += p
    else if (!('kind' in p)) {
      if (p.arg === '#') out += new Intl.NumberFormat(locale).format(hash ?? 0)
      else {
        const v = params[p.arg]
        out += v === undefined ? `{${p.arg}}` : Array.isArray(v) ? v.join(', ') : String(v)
      }
    } else if (p.kind === 'plural') {
      const n = Number(params[p.arg] ?? 0)
      const branch = p.options[`=${n}`] ?? p.options[new Intl.PluralRules(locale).select(n)] ?? p.options.other ?? []
      out += render(branch, params, locale, n)
    } else {
      const branch = p.options[String(params[p.arg])] ?? p.options.other ?? []
      out += render(branch, params, locale, hash)
    }
  }
  return out
}

const cache = new Map<string, Part[]>()

/** Format an ICU message: `formatIcu('{count, plural, one {# day} other {# days}}', { count: 2 }, 'en')` → `2 days`. */
export function formatIcu(message: string, params: Record<string, unknown> = {}, locale = 'en'): string {
  let parts = cache.get(message)
  if (!parts) {
    parts = parse(message)
    if (cache.size > 5000) cache.clear()
    cache.set(message, parts)
  }
  return render(parts, params, locale)
}
