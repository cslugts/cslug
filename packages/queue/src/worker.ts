import { hostname } from 'node:os'
import { type Application, type Logger, Metrics, type RateLimit, RateLimiter } from '@cslug/core'
import { decode, type Redis } from '@cslug/redis'
import { backoffDelay, findJob, settingsOf } from './job'
import { type Envelope, runFailedHook, runJob } from './queue'
import { BANDS, GROUP, type RedisQueue } from './redis-queue'

export type WorkerOptions = {
  queues: { name: string; concurrency: number; rateLimit?: RateLimit }[]
  /** A job whose worker stopped renewing it for this long is taken over by another worker. Default 30 s. */
  leaseMs?: number
  /** How long one blocking read waits (also the delay before a due delayed job is noticed). Default 1 s. */
  blockMs?: number
}

type Entry = { stream: string; id: string; envelope: Envelope; deliveries: number }

/**
 * Runs jobs from one or more queues: a read loop per queue on its own Redis connection (spike c), at most
 * `concurrency` jobs at a time per queue, retries with backoff, the failed store after the last attempt,
 * lease renewal while a job runs and takeover (`XAUTOCLAIM`) of jobs whose worker died.
 */
export class Worker {
  readonly consumer = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`
  private running = false
  private readonly loops: Promise<void>[] = []
  private readonly readers = new Set<Redis>()
  private readonly active = new Set<Promise<void>>()
  private readonly leaseMs: number
  private readonly blockMs: number

  constructor(
    private readonly app: Application,
    private readonly queue: RedisQueue,
    private readonly options: WorkerOptions,
    private readonly log: Logger,
  ) {
    this.leaseMs = options.leaseMs ?? 30_000
    this.blockMs = options.blockMs ?? 1000
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Start the loops (returns at once). */
  async start(): Promise<void> {
    this.running = true
    for (const q of this.options.queues) {
      await this.queue.ensureGroups(q.name)
      this.loops.push(this.loop(q.name, q.concurrency))
      const metrics = this.app.resolve(Metrics)
      if (metrics.enabled) {
        const attributes = { 'messaging.destination.name': q.name }
        metrics.observe('cslug.queue.waiting', async () => (await this.queue.stats(q.name)).waiting, attributes)
        metrics.observe(
          'cslug.queue.oldest_age',
          async () => (await this.queue.stats(q.name)).oldestAgeMs / 1000,
          attributes,
        )
      }
    }
    this.log.info('queue.worker.started', { consumer: this.consumer, queues: this.options.queues.map((q) => q.name) })
  }

  /** Stop reading, let running jobs finish (up to `timeoutMs`); unfinished ones are taken over after their lease. */
  async stop(timeoutMs = 30_000): Promise<void> {
    if (!this.running) return
    this.running = false
    for (const r of this.readers) r.close() // a blocked read rejects at once (spike c)
    const done = Promise.allSettled([...this.loops, ...this.active])
    const finished = await Promise.race([done.then(() => true), Bun.sleep(timeoutMs).then(() => false)])
    if (!finished) this.log.warn('queue.worker.shutdown_timeout', { running: this.active.size })
    this.log.info('queue.worker.stopped', { consumer: this.consumer })
  }

  private async loop(queue: string, concurrency: number): Promise<void> {
    const streams = BANDS.map((b) => this.queue.stream(queue, b))
    let reader: Redis | undefined
    let failures = 0
    let lastClaim = 0
    const mine = new Set<Promise<void>>()
    while (this.running) {
      try {
        while (mine.size >= concurrency && this.running) await Promise.race(mine)
        if (!this.running) break
        await this.queue.promote(queue)
        await this.queue.redis.send('SET', [this.queue.redis.key('heartbeat'), Date.now()])
        if (Date.now() - lastClaim > this.leaseMs / 2) {
          lastClaim = Date.now()
          for (const entry of await this.reclaim(streams, concurrency - mine.size)) this.track(mine, entry)
        }
        if (!reader) {
          reader = this.queue.redis.dedicated()
          this.readers.add(reader)
          await this.queue.ensureGroups(queue, reader)
        }
        const entries = await this.read(reader, streams, concurrency - mine.size)
        failures = 0
        for (const entry of entries) this.track(mine, entry)
      } catch (error) {
        if (!this.running) break
        if (reader) {
          this.readers.delete(reader)
          reader.close()
          reader = undefined
        }
        failures++
        this.log.warn('queue.worker.read_failed', { queue, error, retryInMs: Math.min(30_000, 250 * 2 ** failures) })
        await Bun.sleep(Math.min(30_000, 250 * 2 ** failures))
      }
    }
    if (reader) {
      this.readers.delete(reader)
      reader.close()
    }
    await Promise.allSettled(mine)
  }

  private track(mine: Set<Promise<void>>, entry: Entry): void {
    const p: Promise<void> = this.process(entry).finally(() => {
      mine.delete(p)
      this.active.delete(p)
    })
    mine.add(p)
    this.active.add(p)
  }

  /** One blocking read for new entries, with a client-side deadline in case the connection is wedged. */
  private async read(reader: Redis, streams: string[], count: number): Promise<Entry[]> {
    const keys = streams.map((s) => reader.key(s))
    const args = [
      'GROUP',
      GROUP,
      this.consumer,
      'COUNT',
      Math.max(1, count),
      'BLOCK',
      this.blockMs,
      'STREAMS',
      ...keys,
      ...keys.map(() => '>'),
    ]
    let timer: Timer | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('XREADGROUP did not return in time')), this.blockMs + 5000)
    })
    try {
      const reply = await Promise.race([reader.send('XREADGROUP', args), deadline])
      return parseRead(reply).flatMap(([key, rows]) => {
        const stream = streams[keys.indexOf(key)] ?? key.slice(reader.prefix.length)
        return rows.flatMap(([id, fields]) =>
          fields ? [{ stream, id, envelope: envelopeFrom(fields), deliveries: 1 }] : [],
        )
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /** Take over entries idle longer than the lease (their worker died), with their delivery counts. */
  private async reclaim(streams: string[], count: number): Promise<Entry[]> {
    if (count <= 0) return []
    const out: Entry[] = []
    const redis = this.queue.redis
    for (const stream of streams) {
      const key = redis.key(stream)
      const reply = (await redis.send('XAUTOCLAIM', [
        key,
        GROUP,
        this.consumer,
        this.leaseMs,
        '0',
        'COUNT',
        count,
      ])) as [string, [string, string[] | null][], string[]?]
      for (const [id, fields] of reply[1] ?? []) {
        if (!fields) continue
        const pending = (await redis.send('XPENDING', [key, GROUP, id, id, 1])) as [string, string, number, number][]
        const deliveries = Number(pending[0]?.[3] ?? 2)
        const envelope = envelopeFrom(fields)
        out.push({ stream, id, envelope, deliveries })
        this.log.warn('queue.job.reclaimed', { jobId: envelope.id, job: envelope.name, deliveries })
      }
    }
    return out
  }

  /** Wait for the queue's `rateLimit` (shared by all workers through core's RateLimiter); the lease keeps renewing. */
  private async throttle(queue: string): Promise<void> {
    const rate = this.options.queues.find((q) => q.name === queue)?.rateLimit
    if (!rate) return
    const limiter = this.app.resolve(RateLimiter)
    for (;;) {
      const r = await limiter.hit(`queue:${queue}`, rate)
      if (r.allowed || !this.running) return
      await Bun.sleep(Math.min(1000, Math.max(50, r.retryAfter * 1000)))
    }
  }

  private async process({ stream, id, envelope, deliveries }: Entry): Promise<void> {
    const attempt = envelope.attempt + deliveries
    const fields = { jobId: envelope.id, job: envelope.name, queue: envelope.queue, attempt }
    const renew = setInterval(
      () => {
        this.queue.redis
          .send('XCLAIM', [this.queue.redis.key(stream), GROUP, this.consumer, 0, id, 'JUSTID'])
          .catch(() => {})
      },
      Math.max(100, Math.floor(this.leaseMs / 3)),
    )
    const started = Date.now()
    const metrics = this.app.resolve(Metrics)
    const measure = (outcome: 'done' | 'retry' | 'failed') =>
      metrics.enabled &&
      metrics.record('messaging.process.duration', (Date.now() - started) / 1000, {
        'messaging.destination.name': envelope.queue,
        'cslug.job.name': envelope.name,
        'cslug.job.outcome': outcome,
      })
    try {
      if (attempt > envelope.tries)
        throw new Error(`gave up after ${envelope.tries} attempts (the worker running it stopped)`)
      await this.throttle(envelope.queue)
      await runJob(this.app, envelope, attempt)
      await this.queue.complete(stream, id, envelope)
      await this.queue
        .finished(envelope, true)
        .catch((e) => this.log.error('queue.chain_failed', { ...fields, error: e }))
      measure('done')
      this.log.info('queue.job.done', { ...fields, ms: Date.now() - started })
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown))
      if (attempt < envelope.tries) {
        const cls = findJob(envelope.name)
        const wait = cls ? backoffDelay(settingsOf(cls).backoff, attempt) : 0
        await this.queue
          .retry(stream, id, envelope, this.queue.now() + wait)
          .catch((e) => this.log.error('queue.retry_failed', { ...fields, error: e }))
        measure('retry')
        this.log.warn('queue.job.retrying', { ...fields, error, retryInMs: wait })
      } else {
        const hookError = await runFailedHook(this.app, envelope, error)
        if (hookError) this.log.error('queue.job.failed_hook_threw', { ...fields, error: hookError })
        await this.queue
          .fail(stream, id, envelope, error)
          .catch((e) => this.log.error('queue.fail_failed', { ...fields, error: e }))
        measure('failed')
        this.log.error('queue.job.failed', { ...fields, error })
        await this.queue
          .finished(envelope, false)
          .catch((e) => this.log.error('queue.batch_failed', { ...fields, error: e }))
      }
    } finally {
      clearInterval(renew)
    }
  }
}

type Rows = [string, [string, string[] | null][]][]

/** XREADGROUP replies: RESP3 map `{ stream: entries }` (Bun.redis) or RESP2 `[[stream, entries]]` (spike c). */
export function parseRead(reply: unknown): Rows {
  if (!reply) return []
  if (Array.isArray(reply)) return reply as Rows
  return Object.entries(reply as Record<string, [string, string[] | null][]>)
}

/** The envelope in an entry's fields (`['job', json]`, or a RESP3 map). */
function envelopeFrom(fields: string[] | Record<string, string>): Envelope {
  const json = Array.isArray(fields) ? fields[fields.indexOf('job') + 1] : fields.job
  return decode<Envelope>(json) as Envelope
}
