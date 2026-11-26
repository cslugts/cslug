/** Formatters that run in the browser and on the server (no Node APIs). */

const digits = (currency: string) =>
  new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2

/** `formatMoney('220000', 'EUR', 'fr')` → `2 200,00 €` (amount in minor units; exact for any size). */
export function formatMoneyIn(
  locale: string,
  amount: { amount: unknown; currency: string } | bigint | number | string,
  currency?: string,
): string {
  const value = typeof amount === 'object' && amount !== null ? amount : { amount, currency: currency ?? '' }
  if (!value.currency) throw new Error('formatMoney(): a currency is needed')
  const d = digits(value.currency)
  const minor = BigInt(value.amount as string)
  const negative = minor < 0n
  const abs = (negative ? -minor : minor).toString().padStart(d + 1, '0')
  const decimal = `${negative ? '-' : ''}${d ? `${abs.slice(0, -d)}.${abs.slice(-d)}` : abs}`
  return new Intl.NumberFormat(locale, { style: 'currency', currency: value.currency }).format(decimal as `${number}`)
}

const STYLES = {
  short: { dateStyle: 'short' },
  medium: { dateStyle: 'medium' },
  long: { dateStyle: 'long' },
  full: { dateStyle: 'full' },
} as const

/** Calendar dates (`'YYYY-MM-DD'`) as is; instants in `tz` (default: the browser's). */
export function formatDateIn(
  locale: string,
  value: Date | string,
  style: keyof typeof STYLES | Intl.DateTimeFormatOptions = 'medium',
  tz?: string,
): string {
  const calendar = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  const date = calendar ? new Date(`${value}T12:00:00Z`) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`formatDate(): invalid date ${String(value)}`)
  const base = typeof style === 'string' ? STYLES[style] : style
  return new Intl.DateTimeFormat(locale, { ...base, timeZone: calendar ? 'UTC' : tz }).format(date)
}

/** Minutes as "2 h 30 min" with locale unit names. */
export function formatDurationIn(locale: string, minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  const fmt = (n: number, unit: 'hour' | 'minute') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(n)
  return h && m ? `${fmt(h, 'hour')} ${fmt(m, 'minute')}` : h ? fmt(h, 'hour') : fmt(m, 'minute')
}
