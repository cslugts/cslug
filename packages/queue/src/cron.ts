import { CslugError } from '@cslug/core'

const NAMES: Record<string, number> = Object.fromEntries([
  ...'sun mon tue wed thu fri sat'.split(' ').map((d, i) => [d, i]),
  ...'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ').map((m, i) => [m, i + 1]),
])
const FIELDS = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day of month', 1, 31],
  ['month', 1, 12],
  ['day of week', 0, 7],
] as const

/** Wall-clock parts of an instant in a time zone. */
export type LocalTime = { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

/**
 * A 5-field cron expression (`minute hour day-of-month month day-of-week`): `*`, lists, ranges, steps, month and
 * day names, 0 or 7 for Sunday. When both day fields are restricted, either matching is enough (as in cron).
 */
export class Cron {
  private readonly sets: Set<number>[]
  private readonly anyDay: boolean
  private readonly anyWeekday: boolean

  constructor(readonly expression: string) {
    const parts = expression.trim().split(/\s+/)
    if (parts.length !== 5) throw cronError(expression, 'needs 5 fields: minute hour day-of-month month day-of-week')
    this.sets = parts.map((p, i) => parseField(p, FIELDS[i] as (typeof FIELDS)[number], expression))
    const weekdays = this.sets[4] as Set<number>
    if (weekdays.has(7)) weekdays.add(0)
    this.anyDay = parts[2] === '*'
    this.anyWeekday = parts[4] === '*'
  }

  matches(t: LocalTime): boolean {
    const [m, h, dom, mon, dow] = this.sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
    return m.has(t.minute) && h.has(t.hour) && mon.has(t.month) && this.dayMatches(dom, dow, t)
  }

  private dayMatches(dom: Set<number>, dow: Set<number>, t: LocalTime): boolean {
    if (this.anyDay && this.anyWeekday) return true
    if (this.anyDay) return dow.has(t.weekday)
    if (this.anyWeekday) return dom.has(t.day)
    return dom.has(t.day) || dow.has(t.weekday)
  }

  /** The first matching minute strictly after `after`, in time zone `tz` (within ~5 years, else undefined). */
  next(after: Date, tz = 'UTC'): Date | undefined {
    let t = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000
    const end = t + 5 * 366 * 86_400_000
    const [m, h, , mon] = this.sets as [Set<number>, Set<number>, Set<number>, Set<number>]
    while (t < end) {
      const local = localTime(new Date(t), tz)
      if (!mon.has(local.month) || !this.dayMatches(this.sets[2] as Set<number>, this.sets[4] as Set<number>, local)) {
        // towards the next local midnight, stopping an hour short so a DST change cannot make us overshoot it
        const toMidnight = (23 - local.hour) * 60 + (60 - local.minute)
        t += Math.max(60 - local.minute, toMidnight - 60) * 60_000
      } else if (!h.has(local.hour)) {
        t += (60 - local.minute) * 60_000
      } else if (!m.has(local.minute)) {
        t += 60_000
      } else {
        return new Date(t)
      }
    }
    return undefined
  }
}

function parseField(field: string, [label, min, max]: (typeof FIELDS)[number], expression: string): Set<number> {
  const out = new Set<number>()
  const value = (s: string) => {
    const n = NAMES[s.toLowerCase()] ?? (/^\d+$/.test(s) ? Number(s) : Number.NaN)
    if (!Number.isInteger(n) || n < min || n > max)
      throw cronError(expression, `${label} "${s}" is not in ${min}–${max}`)
    return n
  }
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw cronError(expression, `bad step in "${part}"`)
    let [from, to] = [min as number, max as number]
    if (range !== '*') {
      const [a, b] = (range ?? '').split('-')
      from = value(a ?? '')
      to = b === undefined ? (stepText === undefined ? from : max) : value(b)
    }
    if (from > to) throw cronError(expression, `${label} range "${range}" goes backwards`)
    for (let n = from; n <= to; n += step) out.add(n)
  }
  return out
}

const cronError = (expression: string, why: string) =>
  new CslugError('schedule.bad_cron', `Invalid cron "${expression}": ${why}`)

const formatters = new Map<string, Intl.DateTimeFormat>()
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Wall-clock parts of `date` in `tz` (an IANA zone). */
export function localTime(date: Date, tz = 'UTC'): LocalTime {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    })
    formatters.set(tz, f)
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]))
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAYS[p.weekday as string] ?? 0,
  }
}
