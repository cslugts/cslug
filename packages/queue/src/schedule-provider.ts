import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { arg, Command, CslugError, flag, Logger, ServiceProvider } from '@cslug/core'
import { QueueProvider } from './provider'
import { RedisQueue } from './redis-queue'
import { buildSchedule, type ScheduleDefinition } from './schedule'
import { Scheduler } from './scheduler'

/**
 * Binds the `Scheduler`, loads `routes/schedule.ts` at boot, contributes the `schedule:*` commands and stops the
 * scheduler loop at shutdown. Config: `schedule.timezone` (default UTC).
 */
export class ScheduleProvider extends ServiceProvider {
  static dependsOn = [QueueProvider]

  register() {
    this.commands(scheduleCommands)
    this.app.singleton(
      Scheduler,
      (c) =>
        new Scheduler(
          this.app,
          c.resolve(RedisQueue).redis,
          this.app.config<string | undefined>('schedule.timezone') ?? 'UTC',
          c.resolve(Logger),
        ),
    )
  }

  async boot() {
    const path = join(this.app.rootDir, 'routes/schedule.ts')
    if (!existsSync(path)) return
    const mod = (await import(path)) as { default?: ScheduleDefinition }
    if (!mod.default?.__schedule)
      throw new CslugError(
        'schedule.no_definition',
        'routes/schedule.ts must `export default defineSchedule((s) => { … })`',
      )
    this.app.resolve(Scheduler).entries = buildSchedule(mod.default)
  }

  async shutdown() {
    await this.app.resolve(Scheduler).stop()
  }
}

abstract class ScheduleCommand extends Command {
  protected get scheduler(): Scheduler {
    return this.app.resolve(Scheduler)
  }
}

/** `cslug schedule:work`: tick every minute until SIGTERM. */
export class ScheduleWorkCommand extends ScheduleCommand {
  static signature = 'schedule:work'
  static description = 'Run the scheduler (every minute)'
  static longRunning = true

  handle() {
    this.scheduler.start()
    this.log.info('schedule.started', { entries: this.scheduler.entries.length })
    if (process.stdout.isTTY) this.info(`Scheduler running: ${this.scheduler.entries.length} entries`)
  }
}

/** `cslug schedule:run`: one tick, for an external cron. */
export class ScheduleRunCommand extends ScheduleCommand {
  static signature = 'schedule:run'
  static description = 'Run the entries due this minute, once'

  async handle() {
    const runs = await this.scheduler.runDue()
    for (const r of runs) this.line(`${r.name}: ${r.status}${r.error ? ` (${r.error})` : ''}`)
    return runs.some((r) => r.status === 'failed') ? 1 : 0
  }
}

/** `cslug schedule:list`: entries, when they run, their time zone and next run. */
export class ScheduleListCommand extends ScheduleCommand {
  static signature = 'schedule:list'
  static description = 'List the scheduled entries'
  static args = { json: flag.boolean() }

  handle({ json }: Command.Args<typeof ScheduleListCommand>) {
    const now = this.clock.now()
    const rows = this.scheduler.entries.map((e) => {
      const next = this.scheduler.next(e, now)
      return {
        name: e.name,
        when: e.description,
        tz: this.scheduler.tzOf(e),
        next: next ? `in ${ago(next.getTime() - now.getTime())}` : '-',
        nextAt: next,
      }
    })
    if (json) this.line(JSON.stringify(rows))
    else this.table(rows.map(({ nextAt: _, ...r }) => r))
  }
}

/** `cslug schedule:history <name> [--last=10]`. */
export class ScheduleHistoryCommand extends ScheduleCommand {
  static signature = 'schedule:history'
  static description = 'Recent runs of an entry'
  static args = { name: arg.string(), last: flag.number().default(10), json: flag.boolean() }

  async handle({ name, last, json }: Command.Args<typeof ScheduleHistoryCommand>) {
    const runs = await this.scheduler.history(name, last)
    if (json) this.line(JSON.stringify(runs))
    else this.table(runs)
  }
}

/** `cslug schedule:test <name>`: run an entry now, once, ignoring its schedule. */
export class ScheduleTestCommand extends ScheduleCommand {
  static signature = 'schedule:test'
  static description = 'Run one entry now, ignoring the schedule'
  static args = { name: arg.string() }

  async handle({ name }: Command.Args<typeof ScheduleTestCommand>) {
    const entry = this.scheduler.find(name)
    if (!entry) {
      this.error(`No schedule entry "${name}" (cslug schedule:list)`)
      return 1
    }
    const run = await this.scheduler.run(entry, this.clock.now(), false)
    this.line(`${name}: ${run?.status}${run?.error ? ` (${run.error})` : ''}`)
    return run?.status === 'failed' ? 1 : 0
  }
}

/** `13h 2m`, `4d 18h`, `45s`. */
function ago(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) return `${Math.round(ms / 1000)}s`
  const [d, h, min] = [Math.floor(m / 1440), Math.floor((m % 1440) / 60), m % 60]
  return d ? `${d}d${h ? ` ${h}h` : ''}` : h ? `${h}h${min ? ` ${min}m` : ''}` : `${min}m`
}

export const scheduleCommands = [
  ScheduleWorkCommand,
  ScheduleRunCommand,
  ScheduleListCommand,
  ScheduleHistoryCommand,
  ScheduleTestCommand,
]
