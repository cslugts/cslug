import { type Application, CslugError, kebab, type resolve } from '@cslug/core'
import { Cron, type LocalTime } from './cron'
import type { JobClass, PayloadOf } from './job'

/** What an inline `s.call()` task receives. */
export type TaskContext = { app: Application; resolve: typeof resolve }
type Task = (ctx: TaskContext) => unknown

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
export type Weekday = (typeof DAYS)[number]

const hm = (time: string): [number, number] => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time)
  const [h, min] = [Number(m?.[1]), Number(m?.[2])]
  if (!m || h > 23 || min > 59) throw new CslugError('schedule.bad_time', `Use "HH:MM" (24 h), not "${time}"`)
  return [h, min]
}
const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`

/**
 * One scheduled entry: when it runs (cron, by default every minute) and what it does (dispatch a job, or an
 * inline task). Frequency helpers replace the cron; modifiers narrow it.
 */
export class ScheduleEntry {
  crons: Cron[] = [new Cron('* * * * *')]
  description = 'every minute'
  tz?: string
  overlap = false
  catchUpMode?: 'once'
  private filters: ((t: LocalTime, app: Application) => boolean)[] = []

  constructor(
    public name: string,
    readonly job?: JobClass,
    readonly payload?: unknown,
    readonly task?: Task,
  ) {}

  /** Raw cron (5 fields). */
  cron(expression: string): this {
    return this.at([expression], expression)
  }
  everyMinute(): this {
    return this.at(['* * * * *'], 'every minute')
  }
  everyFiveMinutes(): this {
    return this.at(['*/5 * * * *'], 'every 5 minutes')
  }
  everyTenMinutes(): this {
    return this.at(['*/10 * * * *'], 'every 10 minutes')
  }
  everyFifteenMinutes(): this {
    return this.at(['*/15 * * * *'], 'every 15 minutes')
  }
  everyThirtyMinutes(): this {
    return this.at(['*/30 * * * *'], 'every 30 minutes')
  }
  hourly(): this {
    return this.at(['0 * * * *'], 'hourly')
  }
  hourlyAt(minute: number): this {
    return this.at([`${minute} * * * *`], `hourly at :${String(minute).padStart(2, '0')}`)
  }
  daily(): this {
    return this.dailyAt('00:00')
  }
  dailyAt(time: string): this {
    const [h, m] = hm(time)
    return this.at([`${m} ${h} * * *`], `daily ${time}`)
  }
  twiceDaily(first: string, second: string): this {
    const [[h1, m1], [h2, m2]] = [hm(first), hm(second)]
    return this.at([`${m1} ${h1} * * *`, `${m2} ${h2} * * *`], `daily ${first} and ${second}`)
  }
  weekly(): this {
    return this.weeklyOn('sunday', '00:00')
  }
  weeklyOn(day: Weekday, time = '00:00'): this {
    const [h, m] = hm(time)
    const n = DAYS.indexOf(day)
    if (n < 0) throw new CslugError('schedule.bad_day', `weeklyOn(): "${day}" is not a weekday name`)
    return this.at([`${m} ${h} * * ${n}`], `${day}s ${time}`)
  }
  monthly(): this {
    return this.monthlyOn(1, '00:00')
  }
  monthlyOn(day: number, time = '00:00'): this {
    const [h, m] = hm(time)
    return this.at([`${m} ${h} ${day} * *`], `monthly ${ordinal(day)} ${time}`)
  }

  /** Only Monday to Friday. */
  weekdays(): this {
    this.description += ', weekdays'
    return this.filter((t) => t.weekday >= 1 && t.weekday <= 5)
  }
  /** Only between two local times (inclusive). */
  between(from: string, to: string): this {
    const [a, b] = [hm(from), hm(to)].map(([h, m]) => h * 60 + m) as [number, number]
    this.description += `, ${from}–${to}`
    return this.filter((t) => t.hour * 60 + t.minute >= a && t.hour * 60 + t.minute <= b)
  }
  /** Only when `fn` returns true at the tick. */
  when(fn: () => boolean): this {
    return this.filter(() => fn())
  }
  /** Only in these `app.env` values. */
  environments(envs: readonly string[]): this {
    return this.filter((_, app) => envs.includes(String(app.config('app.env') ?? 'development')))
  }
  /** Interpret times in this IANA zone (default: `schedule.timezone`, else UTC). */
  timezone(tz: string): this {
    this.tz = tz
    return this
  }
  /** Start even if the previous run is still going. */
  allowOverlap(): this {
    this.overlap = true
    return this
  }
  /** After downtime, run one missed tick on recovery (default: missed ticks are skipped). */
  catchUp(mode: 'once'): this {
    this.catchUpMode = mode
    return this
  }
  /** Rename the entry (history, locks, `schedule:test`). */
  as(name: string): this {
    this.name = name
    return this
  }

  /** Due at this local minute? */
  isDue(t: LocalTime, app: Application): boolean {
    return this.crons.some((c) => c.matches(t)) && this.filters.every((f) => f(t, app))
  }

  /** The next due minute after `after` (filters included), in `tz`. */
  nextAfter(after: Date, tz: string, app: Application, localOf: (d: Date) => LocalTime): Date | undefined {
    let from = after
    for (let i = 0; i < 10_000; i++) {
      const candidates = this.crons.map((c) => c.next(from, tz)).filter((d): d is Date => !!d)
      if (!candidates.length) return undefined
      const next = new Date(Math.min(...candidates.map((d) => d.getTime())))
      if (this.filters.every((f) => f(localOf(next), app))) return next
      from = next
    }
    return undefined
  }

  private at(expressions: string[], description: string): this {
    this.crons = expressions.map((e) => new Cron(e))
    this.description = description
    return this
  }
  private filter(fn: (t: LocalTime, app: Application) => boolean): this {
    this.filters.push(fn)
    return this
  }
}

/** The builder `routes/schedule.ts` receives. */
export class ScheduleBuilder {
  readonly entries: ScheduleEntry[] = []

  /** Dispatch this job (to the queue; the scheduler stays light). */
  job<J extends JobClass<never>>(
    job: J,
    ...payload: PayloadOf<J> extends undefined ? [] : [PayloadOf<J>]
  ): ScheduleEntry {
    return this.add(new ScheduleEntry(entryName(job.name), job as JobClass, payload[0]))
  }
  /** Run a small task inline, in the scheduler process (keep it fast). */
  call(name: string, task: Task): ScheduleEntry {
    return this.add(new ScheduleEntry(name, undefined, undefined, task))
  }
  /** `s.cron('0 *\/6 * * *', 'db:vacuum', VacuumJob)`: a job on a raw cron with a name. */
  cron<J extends JobClass<never>>(
    expression: string,
    name: string,
    job: J,
    ...payload: PayloadOf<J> extends undefined ? [] : [PayloadOf<J>]
  ): ScheduleEntry {
    return this.add(new ScheduleEntry(name, job as JobClass, payload[0]).cron(expression))
  }

  private add(entry: ScheduleEntry): ScheduleEntry {
    this.entries.push(entry)
    return entry
  }
}

/** `SendDueRemindersJob` → `send-due-reminders`. */
export const entryName = (className: string) => kebab(className.replace(/Job$/, '')).replace(/^-/, '')

export type ScheduleDefinition = { readonly __schedule: true; define(s: ScheduleBuilder): void }

/** `routes/schedule.ts`: `export default defineSchedule((s) => { s.job(ReportJob).dailyAt('07:00') })`. */
export function defineSchedule(define: (s: ScheduleBuilder) => void): ScheduleDefinition {
  return { __schedule: true, define }
}

/** Build the entries of a definition; names must be unique. */
export function buildSchedule(definition: ScheduleDefinition): ScheduleEntry[] {
  const builder = new ScheduleBuilder()
  definition.define(builder)
  const seen = new Set<string>()
  for (const e of builder.entries) {
    if (seen.has(e.name))
      throw new CslugError(
        'schedule.duplicate_name',
        `Two schedule entries are named "${e.name}": rename one with .as(name)`,
      )
    seen.add(e.name)
  }
  return builder.entries
}
