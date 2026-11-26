import { type Application, Clock, Lock, type Logger, resolve, runInContext } from '@cslug/core'
import type { Redis } from '@cslug/redis'
import { decode, encode } from '@cslug/redis'
import { localTime } from './cron'
import { Queue } from './queue'
import type { ScheduleEntry } from './schedule'

/** One recorded run (`cslug schedule:history`). */
export type ScheduleRun = {
  name: string
  scheduledFor: Date
  startedAt: Date
  finishedAt?: Date
  /** `dispatched` (job sent to the queue), `ok` / `failed` (inline task), `skipped` (previous run still going). */
  status: 'dispatched' | 'ok' | 'failed' | 'skipped'
  error?: string
}

const KEEP = 100

/**
 * Runs `routes/schedule.ts`: each minute, every due entry runs once across all scheduler instances (a lock per
 * entry and tick), not while its previous run is still going (unless `allowOverlap()`), and is recorded.
 */
export class Scheduler {
  entries: ScheduleEntry[] = []
  private running = false
  private wake?: () => void
  private loop?: Promise<void>

  constructor(
    private readonly app: Application,
    private readonly store: Redis | undefined,
    private readonly timezone: string,
    private readonly log: Logger,
  ) {}

  tzOf(entry: ScheduleEntry): string {
    return entry.tz ?? this.timezone
  }

  find(name: string): ScheduleEntry | undefined {
    return this.entries.find((e) => e.name === name)
  }

  next(entry: ScheduleEntry, after: Date = this.now()): Date | undefined {
    const tz = this.tzOf(entry)
    return entry.nextAfter(after, tz, this.app, (d) => localTime(d, tz))
  }

  /**
   * Run every entry due at `now`'s minute. `exclusive: false` skips the once-per-tick lock (tests, where the
   * same tick is replayed). Returns the runs this instance made.
   */
  async runDue(now: Date = this.now(), options: { exclusive?: boolean } = {}): Promise<ScheduleRun[]> {
    const tick = new Date(Math.floor(now.getTime() / 60_000) * 60_000)
    const runs: ScheduleRun[] = []
    for (const entry of this.entries) {
      if (!entry.isDue(localTime(tick, this.tzOf(entry)), this.app)) continue
      const run = await this.run(entry, tick, options.exclusive ?? true)
      if (run) runs.push(run)
    }
    return runs
  }

  /** Run one entry for `tick` (no schedule check). `exclusive`: take the once-per-tick lock first. */
  async run(entry: ScheduleEntry, tick: Date, exclusive = true): Promise<ScheduleRun | undefined> {
    const lock = this.app.resolve(Lock)
    if (exclusive && !(await lock.acquire(`schedule:${entry.name}:${tick.toISOString()}`, '10m'))) return undefined
    const run: ScheduleRun = { name: entry.name, scheduledFor: tick, startedAt: this.now(), status: 'ok' }
    const scope = this.app.createScope()
    try {
      await runInContext({ app: this.app, scope, requestId: `schedule:${entry.name}` }, async () => {
        if (entry.job) {
          let dispatch = this.app.resolve(Queue).dispatch(entry.job as never, entry.payload as never)
          if (!entry.overlap) dispatch = dispatch.unique(`schedule:${entry.name}`)
          run.status = (await dispatch) === null ? 'skipped' : 'dispatched'
          return
        }
        const held = entry.overlap ? undefined : await lock.acquire(`schedule:${entry.name}:running`, '1h')
        if (!entry.overlap && !held) {
          run.status = 'skipped'
          return
        }
        try {
          await entry.task?.({ app: this.app, resolve })
        } finally {
          await held?.release()
        }
      })
    } catch (error) {
      run.status = 'failed'
      run.error = error instanceof Error ? error.message : String(error)
      this.log.error('schedule.failed', { entry: entry.name, error })
    } finally {
      await scope.dispose()
    }
    run.finishedAt = this.now()
    if (run.status !== 'failed')
      this.log.info(`schedule.${run.status}`, { entry: entry.name, tick: tick.toISOString() })
    await this.record(run)
    return run
  }

  /** For entries with `catchUp('once')`: if a tick was missed since the last recorded run, run it once now. */
  async catchUp(now: Date = this.now()): Promise<ScheduleRun[]> {
    const tick = Math.floor(now.getTime() / 60_000) * 60_000
    const runs: ScheduleRun[] = []
    for (const entry of this.entries.filter((e) => e.catchUpMode === 'once')) {
      const [last] = await this.history(entry.name, 1)
      const missed = last && this.next(entry, last.scheduledFor)
      if (!missed || missed.getTime() >= tick) continue
      const run = await this.run(entry, missed)
      if (run) runs.push(run)
    }
    return runs
  }

  async history(name: string, last = 10): Promise<ScheduleRun[]> {
    if (!this.store) return []
    const rows = (await this.store.send('LRANGE', [
      this.store.key(`schedule:history:${name}`),
      0,
      last - 1,
    ])) as string[]
    return rows.map((r) => decode<ScheduleRun>(r) as ScheduleRun)
  }

  /** Last time the loop ticked (epoch ms), for health checks. */
  async heartbeat(): Promise<number | undefined> {
    const v = this.store ? await this.store.send('GET', [this.store.key('schedule:heartbeat')]) : null
    return v ? Number(v) : undefined
  }

  /** Tick at the start of every minute until `stop()`. */
  start(): void {
    if (this.running) return
    this.running = true
    this.loop = (async () => {
      await this.catchUp().catch((error) => this.log.error('schedule.catch_up_failed', { error }))
      while (this.running) {
        await this.store?.send('SET', [this.store.key('schedule:heartbeat'), Date.now()]).catch(() => {})
        const wait = 60_000 - (Date.now() % 60_000) + 50
        await new Promise<void>((r) => {
          const timer = setTimeout(r, wait)
          this.wake = () => {
            clearTimeout(timer)
            r()
          }
        })
        if (!this.running) break
        await this.runDue().catch((error) => this.log.error('schedule.tick_failed', { error }))
      }
    })()
  }

  /** Stop after the current tick. */
  async stop(): Promise<void> {
    this.running = false
    this.wake?.()
    await this.loop
  }

  private now(): Date {
    return this.app.resolve(Clock).now()
  }

  private async record(run: ScheduleRun): Promise<void> {
    if (!this.store) return
    const key = this.store.key(`schedule:history:${run.name}`)
    await this.store.send('LPUSH', [key, encode(run)]).catch(() => {})
    await this.store.send('LTRIM', [key, 0, KEEP - 1]).catch(() => {})
  }
}
