import { join } from 'node:path'
import { arg, Command, defineGenerator, flag, parseDuration } from '@cslug/core'
import { discoverJobs } from './discover'
import type { QueueConfig } from './provider'
import { Workers } from './provider'
import { RedisQueue } from './redis-queue'

abstract class QueueCommand extends Command {
  protected get queue(): RedisQueue {
    return this.app.resolve(RedisQueue)
  }
  protected get config(): QueueConfig {
    return this.app.config<QueueConfig | undefined>('queue') ?? {}
  }
}

/** `cslug queue:work`: run jobs until SIGTERM (running jobs finish, up to `queue.shutdownTimeout`). */
export class QueueWorkCommand extends QueueCommand {
  static signature = 'queue:work'
  static description = 'Run queued jobs'
  static longRunning = true
  static args = {
    queues: flag.list().describe('Queues to run (default: every queue in config/queue.ts)'),
    queue: flag.list().describe('Same as --queues'),
    concurrency: flag.number().optional().describe('Jobs at a time per queue (default: config, else 1)'),
  }

  async handle({ queues, queue, concurrency }: Command.Args<typeof QueueWorkCommand>) {
    const configured = this.config.queues ?? {}
    const names = [...queues, ...queue].length ? [...new Set([...queues, ...queue])] : Object.keys(configured)
    if (!names.length) names.push('default')
    const jobs = await discoverJobs(this.app)
    const list = names.map((name) => ({
      name,
      concurrency: concurrency ?? configured[name]?.concurrency ?? 1,
      rateLimit: configured[name]?.rateLimit,
    }))
    await this.app.resolve(Workers).start(list)
    if (process.stdout.isTTY)
      this.info(`Working ${list.map((q) => `${q.name} (×${q.concurrency})`).join(', ')}; ${jobs} job classes`)
  }
}

/** `cslug queue:failed`: jobs that failed their last attempt. */
export class QueueFailedCommand extends QueueCommand {
  static signature = 'queue:failed'
  static description = 'List failed jobs'
  static args = { json: flag.boolean() }

  async handle({ json }: Command.Args<typeof QueueFailedCommand>) {
    const rows = (await this.queue.failed()).map((f) => ({
      id: f.envelope.id,
      job: f.envelope.name,
      queue: f.envelope.queue,
      attempts: f.envelope.tries,
      failedAt: new Date(f.failedAt),
      error: f.error,
    }))
    if (json) this.line(JSON.stringify(rows))
    else this.table(rows)
  }
}

/** `cslug queue:retry <id|all>`: queue failed jobs again, from their first attempt. */
export class QueueRetryCommand extends QueueCommand {
  static signature = 'queue:retry'
  static description = 'Retry a failed job (or all)'
  static args = { id: arg.string().describe('Job id, or "all"') }

  async handle({ id }: Command.Args<typeof QueueRetryCommand>) {
    const ids = id === 'all' ? (await this.queue.failed()).map((f) => f.envelope.id) : [id]
    let n = 0
    for (const one of ids) if (await this.queue.retryFailed(one)) n++
    if (!n && id !== 'all') {
      this.error(`No failed job ${id}`)
      return 1
    }
    this.success(`${n} job(s) queued again`)
    return 0
  }
}

/** `cslug queue:forget <id>`: delete a failed job. */
export class QueueForgetCommand extends QueueCommand {
  static signature = 'queue:forget'
  static description = 'Delete a failed job'
  static args = { id: arg.string() }

  async handle({ id }: Command.Args<typeof QueueForgetCommand>) {
    if (!(await this.queue.forget(id))) {
      this.error(`No failed job ${id}`)
      return 1
    }
    this.success(`Forgot ${id}`)
    return 0
  }
}

/** `cslug queue:clear [queue]`: delete waiting and delayed jobs. */
export class QueueClearCommand extends QueueCommand {
  static signature = 'queue:clear'
  static description = 'Delete the waiting and delayed jobs of a queue'
  static args = { name: arg.string().default('default'), force: flag.boolean() }

  async handle({ name, force }: Command.Args<typeof QueueClearCommand>) {
    if (this.app.config('app.env') === 'production' && !force) {
      this.error('queue:clear in production: add --force if you really mean it')
      return 1
    }
    await this.queue.clear(name)
    this.success(`Cleared ${name}`)
    return 0
  }
}

/** `cslug queue:stats`: waiting / active / delayed / failed per queue, and the oldest waiting job's age. */
export class QueueStatsCommand extends QueueCommand {
  static signature = 'queue:stats'
  static description = 'Jobs per queue and state'
  static args = { json: flag.boolean() }

  async handle({ json }: Command.Args<typeof QueueStatsCommand>) {
    const names = [...new Set([...Object.keys(this.config.queues ?? {}), ...(await this.queue.queues())])].sort()
    const rows = []
    for (const name of names) rows.push(await this.queue.stats(name))
    if (json) this.line(JSON.stringify(rows))
    else
      this.table(rows.map((r) => ({ ...r, oldestAge: `${Math.round(r.oldestAgeMs / 1000)}s`, oldestAgeMs: undefined })))
  }
}

/** `cslug queue:health`: exit 1 if no worker ran its loop lately or a queue's oldest job waits too long. */
export class QueueHealthCommand extends QueueCommand {
  static signature = 'queue:health'
  static description = 'Check the workers (for services without HTTP)'
  static args = {
    stale: flag.string().default('2m').describe('A worker heartbeat older than this is a problem'),
    maxWait: flag.string().default('10m').describe('A job waiting longer than this is a problem'),
  }

  async handle({ stale, maxWait }: Command.Args<typeof QueueHealthCommand>) {
    const problems: string[] = []
    const redis = this.queue.redis
    const beat = Number(await redis.send('GET', [redis.key('heartbeat')]))
    if (!beat || Date.now() - beat > parseDuration(stale)) problems.push(`no worker heartbeat within ${stale}`)
    const names = [...new Set([...Object.keys(this.config.queues ?? {}), ...(await this.queue.queues())])]
    for (const name of names) {
      const s = await this.queue.stats(name)
      if (s.waiting > 0 && s.oldestAgeMs > parseDuration(maxWait))
        problems.push(`${name}: oldest job waiting ${Math.round(s.oldestAgeMs / 1000)}s`)
    }
    for (const p of problems) this.error(p)
    if (!problems.length) this.success('queue healthy')
    return problems.length ? 1 : 0
  }
}

const STUBS = join(import.meta.dir, '../stubs')

/** `cslug make:job SendCheckin` → `app/jobs/send-checkin-job.ts`. */
export const MakeJobCommand = defineGenerator({
  kind: 'job',
  description: 'Create a job',
  stubs: STUBS,
  files: (n) => [{ stub: 'job.stub', target: `app/jobs/${n.file}.ts` }],
})

export const queueCommands = [
  MakeJobCommand,
  QueueHealthCommand,
  QueueWorkCommand,
  QueueFailedCommand,
  QueueRetryCommand,
  QueueForgetCommand,
  QueueClearCommand,
  QueueStatsCommand,
]
