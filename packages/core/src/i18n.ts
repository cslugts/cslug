import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Translate } from '@cslug/validation'
import { currentApp, currentContext, runInContext } from './context'
import { CslugError } from './errors'
import { Money } from './money'

// ── ICU message format (the subset apps use: arguments, plural with =N and #, select) ───────────────────
type Part = string | { arg: string } | { arg: string; kind: 'plural' | 'select'; options: Record<string, Part[]> }

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

// ── translator ───────────────────────────────────────────────────────────────────────────────────────
export type I18nConfig = {
  locales?: readonly string[]
  default?: string
  /** Fallback per locale, e.g. `{ it: 'en', fr: 'en' }`; the default locale is always the last resort. */
  fallback?: Record<string, string>
}

type Messages = Record<string, unknown>

const flatten = (obj: Messages, prefix = '', out: Map<string, string> = new Map()): Map<string, string> => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out.set(key, v)
    else if (v && typeof v === 'object') flatten(v as Messages, key, out)
  }
  return out
}

/** Loads `resources/lang/<locale>.json` and `resources/lang/<locale>/<namespace>.json`, and formats messages. */
export class Translator {
  readonly locales: readonly string[]
  readonly defaultLocale: string
  private readonly fallback: Record<string, string>
  private readonly messages = new Map<string, Map<string, string>>()
  private readonly compiled = new Map<string, Part[]>()

  constructor(config: I18nConfig = {}, messages: Record<string, Messages> = {}) {
    this.defaultLocale = config.default ?? 'en'
    this.locales = config.locales ?? [this.defaultLocale]
    this.fallback = config.fallback ?? {}
    for (const [locale, m] of Object.entries(messages)) this.add(locale, m)
  }

  /** Read every locale's files from a directory (missing directory = no messages). */
  static fromDirectory(dir: string, config: I18nConfig = {}): Translator {
    const translator = new Translator(config)
    if (!existsSync(dir)) return translator
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (entry.endsWith('.json')) translator.add(entry.slice(0, -5), JSON.parse(readFileSync(full, 'utf8')))
      else if (statSync(full).isDirectory()) {
        for (const file of readdirSync(full).filter((f) => f.endsWith('.json'))) {
          translator.add(entry, { [file.slice(0, -5)]: JSON.parse(readFileSync(join(full, file), 'utf8')) })
        }
      }
    }
    return translator
  }

  add(locale: string, messages: Messages): this {
    const map = this.messages.get(locale) ?? new Map<string, string>()
    for (const [k, v] of flatten(messages)) map.set(k, v)
    this.messages.set(locale, map)
    return this
  }

  /** The locales tried for a locale: itself, its fallback chain, then the default. */
  chain(locale: string): string[] {
    const out: string[] = []
    for (let l: string | undefined = locale; l && !out.includes(l); l = this.fallback[l]) out.push(l)
    if (!out.includes(this.defaultLocale)) out.push(this.defaultLocale)
    return out
  }

  /** Formatted message, or undefined if no locale in the chain has the key. */
  translate(
    key: string,
    params: Record<string, unknown> = {},
    locale: string = this.defaultLocale,
  ): string | undefined {
    for (const l of this.chain(locale)) {
      const message = this.messages.get(l)?.get(key)
      if (message === undefined) continue
      const cacheKey = `${l}\u0000${key}`
      let parts = this.compiled.get(cacheKey)
      if (!parts) {
        parts = parse(message)
        this.compiled.set(cacheKey, parts)
      }
      return render(parts, params, l)
    }
    return undefined
  }

  has(key: string, locale: string = this.defaultLocale): boolean {
    return this.chain(locale).some((l) => this.messages.get(l)?.has(key))
  }

  /** Keys of one locale (for `cslug i18n:check`). */
  keys(locale: string): string[] {
    return [...(this.messages.get(locale)?.keys() ?? [])]
  }
}

// ── helpers that read the ambient locale ───────────────────────────────────────────────────────────────
const translator = () => currentApp().resolve(Translator)

/** The current locale: the context's (set by the locale middleware, a job, `withLocale`), else the default. */
export function currentLocale(): string {
  return (currentContext()?.locale as string | undefined) ?? translator().defaultLocale
}

/** Translate: `t('bookings.travellers', { count: 3 })`. A missing key returns the key itself. */
export function t(key: string, params: Record<string, unknown> = {}, locale?: string): string {
  return translator().translate(key, params, locale ?? currentLocale()) ?? key
}

/** Run `fn` with another locale (mail to a recipient, a job for a user). */
export function withLocale<T>(locale: string, fn: () => T): T {
  const ctx = currentContext()
  const app = ctx?.app ?? currentApp()
  return runInContext({ ...(ctx ?? { scope: app }), app, locale }, fn)
}

/** Pick the current locale from translated content (`{ fr, en, it }` jsonb columns), with the fallback chain. */
export function tr(value: Partial<Record<string, string>> | string | null | undefined, locale?: string): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  for (const l of translator().chain(locale ?? currentLocale())) if (value[l]) return value[l] as string
  return Object.values(value).find((v) => !!v) ?? ''
}

/** For `ValidationError.messages(...)`: validation keys in the current locale, English fallbacks otherwise. */
export const validationTranslator =
  (locale?: string): Translate =>
  (key, params) =>
    translator().translate(key, params, locale ?? currentLocale())

/** `formatMoney(220000n, 'EUR')` or `formatMoney(money)` in the current locale. */
export function formatMoney(amount: Money | bigint | number | string, currency?: string, locale?: string): string {
  const money = amount instanceof Money ? amount : Money.of(amount, currency ?? '')
  return money.format(locale ?? currentLocale())
}

const DATE_STYLES = {
  short: { dateStyle: 'short' },
  medium: { dateStyle: 'medium' },
  long: { dateStyle: 'long' },
  full: { dateStyle: 'full' },
} as const

/**
 * `formatDate('2027-05-14', 'long')` → "14 mai 2027" (fr). Calendar dates (`'YYYY-MM-DD'`) are shown as is;
 * instants (`Date`) are shown in `tz` (default: the app clock's time zone).
 */
export function formatDate(
  value: Date | string,
  style: keyof typeof DATE_STYLES | Intl.DateTimeFormatOptions = 'medium',
  options: { tz?: string; locale?: string } = {},
): string {
  const calendar = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  const date = calendar ? new Date(`${value}T12:00:00Z`) : new Date(value)
  if (Number.isNaN(date.getTime()))
    throw new CslugError('i18n.invalid_date', `formatDate(): invalid date ${String(value)}`)
  const base = typeof style === 'string' ? DATE_STYLES[style] : style
  const timeZone = calendar
    ? 'UTC'
    : (options.tz ?? (currentApp().config('app.timezone') as string | undefined) ?? 'UTC')
  return new Intl.DateTimeFormat(options.locale ?? currentLocale(), { ...base, timeZone }).format(date)
}
