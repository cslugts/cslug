import { Clock, type Duration, EventBus, Logger, parseDuration, type RateLimit, ServiceProvider } from '@cslug/core'
import { RedisConnections, RedisProvider } from '@cslug/redis'
import { queueCommands } from './commands'
import { discoverJobs } from './discover'
import { describeJobs } from './job'
import { QueuedListenerJob } from './listener-job'
import { Outbox } from './outbox'
import { Queue } from './queue'
import { RedisQueue } from './redis-queue'
import { Worker, type WorkerOptions } from './worker'

/** `config/queue.ts`. */
export type QueueConfig = {
  /** Redis connection name (config/redis.ts). Default `'default'`. */
  connection?: string
  /** Queues a plain `cslug queue:work` runs: concurrency (default 1) and an optional rate (`'30/s'`, all workers). */
  queues?: Record<string, { concurrency?: number; rateLimit?: RateLimit }>
  failed?: { keep?: Duration }
  /** How long `SIGTERM` waits for running jobs. Default `'30s'`. */
  shutdownTimeout?: Duration
  /** A job whose worker stopped renewing it for this long is taken over. Default `'30s'`. */
  lease?: Duration
  /** One blocking read; also how soon a due delayed job is noticed. Default `'1s'`. */
  block?: Duration
}

/** The workers running in this process (and the outbox relay), stopped gracefully when the app shuts down. */
export class Workers {
  private readonly all = new Set<Worker>()
  private relay?: Timer

  constructor(
    private readonly create: (options: Omit<WorkerOptions, 'leaseMs' | 'blockMs'>) => Worker,
    private readonly shutdownMs: number,
    private readonly outbox: () => Outbox | undefined = () => undefined,
  ) {}

  /** Start a worker for these queues (each `{ name, concurrency, rateLimit? }`). */
  async start(queues: WorkerOptions['queues']): Promise<Worker> {
    const worker = this.create({ queues })
    this.all.add(worker)
    await worker.start()
    const outbox = this.outbox()
    // rows a crashed process left in the outbox (the fast path relays at COMMIT)
    this.relay ??= outbox ? setInterval(() => void outbox.relay().catch(() => {}), 1000) : undefined
    return worker
  }

  async stopAll(timeoutMs = this.shutdownMs): Promise<void> {
    clearInterval(this.relay)
    this.relay = undefined
    await Promise.all([...this.all].map((w) => w.stop(timeoutMs)))
    this.all.clear()
  }
}

/**
 * Binds `Queue` (Redis Streams, on the connection `queue.connection`), runs queued event listeners as jobs,
 * contributes the `queue:*` commands, and stops this process's workers gracefully at shutdown.
 */
export class QueueProvider extends ServiceProvider {
  static dependsOn = [RedisProvider]

  private get config(): QueueConfig {
    return this.app.config<QueueConfig | undefined>('queue') ?? {}
  }

  register() {
    this.commands(queueCommands)
    this.describe('jobs', async () => {
      await discoverJobs(this.app)
      return describeJobs()
    })
    const config = this.config
    this.app.singleton(
      RedisQueue,
      (c) =>
        new RedisQueue(
          c
            .resolve(RedisConnections)
            .get(config.connection ?? 'default')
            .withPrefix('queue:'),
          () => this.app.resolve(Clock).now().getTime(),
          parseDuration(config.failed?.keep ?? '30d'),
        ),
    )
    this.app.singleton(Queue, (c) => c.resolve(RedisQueue))
    this.app.singleton(
      Workers,
      (c) =>
        new Workers(
          (options) =>
            new Worker(
              this.app,
              c.resolve(RedisQueue),
              {
                ...options,
                leaseMs: parseDuration(config.lease ?? '30s'),
                blockMs: parseDuration(config.block ?? '1s'),
              },
              c.resolve(Logger),
            ),
          parseDuration(config.shutdownTimeout ?? '30s'),
          () => (this.app.has(Outbox) ? this.app.resolve(Outbox) : undefined),
        ),
    )
  }

  async boot() {
    const outbox = await Outbox.detect(this.app, this.app.resolve(Logger))
    if (outbox) {
      outbox.registerMigrations()
      this.app.instance(Outbox, outbox)
    }
    // queued listeners become jobs (core runs them in-process when no queue is installed)
    this.app.resolve(EventBus).dispatchQueued = async ({ listener, event, payload, options }) => {
      const dispatch = this.app
        .resolve(Queue)
        .dispatch(QueuedListenerJob, { listener: listener.name, event: event.eventName, payload })
        .immediately() // the bus already waited for COMMIT
      if (options.queue) dispatch.onQueue(options.queue)
      if (options.tries) dispatch.tries(options.tries)
      await dispatch
    }
  }

  async shutdown() {
    await this.app.resolve(Workers).stopAll()
  }
}
