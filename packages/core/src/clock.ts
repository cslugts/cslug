import { type Duration, parseDuration } from './duration'
import { CslugError } from './errors'

const dateFormatters = new Map<string, Intl.DateTimeFormat>()
const partsFormatters = new Map<string, Intl.DateTimeFormat>()

/** `'YYYY-MM-DD'` of an instant in a time zone. */
function dateIn(instant: Date, timezone: string): string {
  let f = dateFormatters.get(timezone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    dateFormatters.set(timezone, f)
  }
  return f.format(instant)
}

/** Offset (ms) of a time zone at an instant: local wall time minus UTC. */
function offsetAt(instant: number, timezone: string): number {
  let f = partsFormatters.get(timezone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    partsFormatters.set(timezone, f)
  }
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, Number(x.value)]))
  const wall = Date.UTC(
    p.year as number,
    (p.month as number) - 1,
    p.day as number,
    p.hour as number,
    p.minute as number,
    p.second as number,
  )
  return wall - (instant - (instant % 1000))
}

/**
 * The time source for domain code. Inject it instead of calling `new Date()`, so tests control time.
 * The default time zone comes from `config/app.ts` → `timezone`.
 */
export class Clock {
  constructor(readonly timezone: string = 'UTC') {
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone })
    } catch {
      throw new CslugError(
        'clock.invalid_timezone',
        `Unknown time zone "${timezone}" (use an IANA name such as "Indian/Antananarivo")`,
      )
    }
  }

  /** The current instant. */
  now(): Date {
    return new Date()
  }

  /** Today's date as `'YYYY-MM-DD'` in a time zone, optionally shifted by whole days. */
  today(offsetDays = 0, timezone: string = this.timezone): string {
    const local = dateIn(this.now(), timezone)
    if (!offsetDays) return local
    const d = new Date(`${local}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + offsetDays)
    return d.toISOString().slice(0, 10)
  }

  /** Now plus a duration (`'2h'`, `'3d'`). */
  add(duration: Duration): Date {
    return new Date(this.now().getTime() + parseDuration(duration))
  }

  /** Now minus a duration (`'90d'`). */
  subtract(duration: Duration): Date {
    return new Date(this.now().getTime() - parseDuration(duration))
  }

  /**
   * The instant of a local wall-clock time on a date in a time zone:
   * `atLocal('2027-05-14', '07:00', 'Indian/Antananarivo')` → 04:00 UTC. Handles daylight saving time.
   */
  atLocal(date: string, time: string, timezone: string = this.timezone): Date {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    const t = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time)
    if (!d || !t)
      throw new CslugError(
        'clock.invalid_input',
        `atLocal() expects 'YYYY-MM-DD' and 'HH:mm', got '${date}', '${time}'`,
      )
    const wall = Date.UTC(
      +(d[1] as string),
      +(d[2] as string) - 1,
      +(d[3] as string),
      +(t[1] as string),
      +(t[2] as string),
      +(t[3] ?? 0),
    )
    // first guess with the offset at the wall time, then correct once with the offset at the result (DST edges)
    let instant = wall - offsetAt(wall, timezone)
    instant = wall - offsetAt(instant, timezone)
    return new Date(instant)
  }
}

/**
 * A Clock for tests. Time is frozen: it moves only when you move it.
 * `travelTo('2027-05-15T05:00:00Z')`, `advance('3d')`, `freeze()` (freeze at the real current time).
 */
export class FakeClock extends Clock {
  private current: number

  constructor(timezone?: string, start: Date | string | number = Date.now()) {
    super(timezone)
    this.current = new Date(start).getTime()
  }

  override now(): Date {
    return new Date(this.current)
  }

  travelTo(instant: Date | string | number): this {
    const t = new Date(instant).getTime()
    if (Number.isNaN(t)) throw new CslugError('clock.invalid_input', `travelTo(): invalid date ${String(instant)}`)
    this.current = t
    return this
  }

  advance(duration: Duration): this {
    this.current += parseDuration(duration)
    return this
  }

  freeze(): this {
    this.current = Date.now()
    return this
  }
}
