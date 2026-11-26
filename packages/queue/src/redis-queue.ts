import { decode, encode, type Redis } from '@cslug/redis'
import { type Envelope, type JobSpec, type PushOptions, Queue } from './queue'

export const GROUP = 'workers'
/** Priority bands, read in this order. */
export const BANDS = ['high', 'normal', 'low'] as const
export type Band = (typeof BANDS)[number]

export const bandOf = (priority = 5): Band => (priority <= 3 ? 'high' : priority >= 8 ? 'low' : 'normal')

/** A job that failed its last attempt (`cslug queue:failed`). */
export type FailedJob = { envelope: Envelope; error: string; stack?: string; failedAt: number }

// Delayed members are "<band letter><envelope json>", so promotion knows which stream to use.
const PROMOTE = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
for _, m in ipairs(due) do
  local band = string.sub(m, 1, 1)
  local stream = KEYS[3]
  if band == 'h' then stream = KEYS[2] elseif band == 'l' then stream = KEYS[4] end
  redis.call('XADD', stream, '*', 'job', string.sub(m, 2))
  redis.call('ZREM', KEYS[1], m)
end
return #due`

// KEYS: stream, unique · ARGV: entry id, job id
const COMPLETE = `
redis.call('XACK', KEYS[1], '${GROUP}', ARGV[1])
redis.call('XDEL', KEYS[1], ARGV[1])
if redis.call('GET', KEYS[2]) == ARGV[2] then redis.call('DEL', KEYS[2]) end
return 1`

// KEYS: stream, delayed · ARGV: entry id, run at, member
const RETRY = `
redis.call('XACK', KEYS[1], '${GROUP}', ARGV[1])
redis.call('XDEL', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
return 1`

// KEYS: stream, unique, failed, failed index · ARGV: entry id, job id, record, now, keep (ms)
const FAIL = `
redis.call('XACK', KEYS[1], '${GROUP}', ARGV[1])
redis.call('XDEL', KEYS[1], ARGV[1])
if redis.call('GET', KEYS[2]) == ARGV[2] then redis.call('DEL', KEYS[2]) end
redis.call('HSET', KEYS[3], ARGV[2], ARGV[3])
redis.call('ZADD', KEYS[4], ARGV[4], ARGV[2])
local old = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', tonumber(ARGV[4]) - tonumber(ARGV[5]), 'LIMIT', 0, 100)
for _, id in ipairs(old) do redis.call('HDEL', KEYS[3], id) redis.call('ZREM', KEYS[4], id) end
return 1`

// KEYS: batch · ARGV: ok (1/0). Returns [failed, next, allow] when the last job finished, else nil.
const BATCH_PROGRESS = `
if redis.call('EXISTS', KEYS[1]) == 0 then return nil end
if ARGV[1] == '0' then redis.call('HINCRBY', KEYS[1], 'failed', 1) end
if redis.call('HINCRBY', KEYS[1], 'pending', -1) > 0 then return nil end
local r = redis.call('HMGET', KEYS[1], 'failed', 'next', 'allow')
redis.call('DEL', KEYS[1])
return r`

/**
 * The queue on Redis Streams (D8): one stream per queue and priority band, read by the consumer group `workers`;
 * a sorted set per queue for delayed jobs and retries; `SET NX` keys for unique jobs; a hash of failed jobs.
 * Keys live under the connection prefix + `queue:`.
 */
export class RedisQueue extends Queue {
  constructor(
    readonly redis: Redis,
    /** Epoch ms; the app's `Clock`, so delays follow a `FakeClock` in tests. */
    readonly now: () => number = Date.now,
    private readonly keepFailed = 30 * 86_400_000,
  ) {
    super()
  }

  stream(queue: string, band: Band = 'normal'): string {
    return band === 'normal' ? `q:${queue}` : `q:${queue}:${band}`
  }
  delayedKey = (queue: string) => `delayed:${queue}`
  uniqueKey = (key = '') => `unique:${key}`

  async push(envelope: Envelope, options: PushOptions = {}): Promise<string | null> {
    if (envelope.unique !== undefined) {
      const held = await this.redis.send('SET', [
        this.redis.key(this.uniqueKey(envelope.unique)),
        envelope.id,
        'NX',
        'PX',
        options.uniqueFor ?? 86_400_000,
      ])
      if (held !== 'OK') return null
    }
    await this.redis.send('SADD', [this.redis.key('queues'), envelope.queue])
    const band = bandOf(envelope.priority)
    if (options.runAt !== undefined && options.runAt > this.now()) {
      await this.redis.send('ZADD', [
        this.redis.key(this.delayedKey(envelope.queue)),
        options.runAt,
        member(band, envelope),
      ])
    } else {
      await this.redis.send('XADD', [this.redis.key(this.stream(envelope.queue, band)), '*', 'job', encode(envelope)])
    }
    return envelope.id
  }

  /** Move due delayed jobs (and retries) of `queue` to its streams. */
  async promote(queue: string, limit = 100): Promise<number> {
    const keys = [this.delayedKey(queue), ...BANDS.map((b) => this.stream(queue, b))]
    return Number(await this.redis.eval(PROMOTE, keys, [this.now(), limit]))
  }

  /** The consumer group on every band of `queue` (idempotent). */
  async ensureGroups(queue: string, redis: Redis = this.redis): Promise<void> {
    for (const band of BANDS) {
      try {
        await redis.send('XGROUP', ['CREATE', redis.key(this.stream(queue, band)), GROUP, '0', 'MKSTREAM'])
      } catch (error) {
        if (!String(error).includes('BUSYGROUP')) throw error
      }
    }
  }

  complete(stream: string, entryId: string, envelope: Envelope): Promise<unknown> {
    return this.redis.eval(COMPLETE, [stream, this.uniqueKey(envelope.unique)], [entryId, envelope.id])
  }

  /** Acknowledge this delivery and queue the next attempt at `runAt`. */
  retry(stream: string, entryId: string, envelope: Envelope, runAt: number): Promise<unknown> {
    const next = { ...envelope, attempt: envelope.attempt + 1 }
    return this.redis.eval(
      RETRY,
      [stream, this.delayedKey(envelope.queue)],
      [entryId, runAt, member(bandOf(envelope.priority), next)],
    )
  }

  /** Acknowledge this delivery and keep the job in the failed store (pruned after `failed.keep`). */
  fail(stream: string, entryId: string, envelope: Envelope, error: Error): Promise<unknown> {
    const record: FailedJob = { envelope, error: error.message, stack: error.stack, failedAt: this.now() }
    return this.redis.eval(
      FAIL,
      [stream, this.uniqueKey(envelope.unique), 'failed', 'failed:index'],
      [entryId, envelope.id, encode(record), this.now(), this.keepFailed],
    )
  }

  protected override async startBatch(id: string, state: { pending: number; next?: JobSpec; allowFailures: boolean }) {
    const key = this.redis.key(`batch:${id}`)
    const next = state.next ? encode(state.next) : ''
    await this.redis.send('HSET', [
      key,
      'pending',
      state.pending,
      'failed',
      0,
      'next',
      next,
      'allow',
      state.allowFailures ? 1 : 0,
    ])
    await this.redis.send('EXPIRE', [key, 7 * 86_400])
  }

  protected override async batchProgress(id: string, ok: boolean) {
    const r = (await this.redis.eval(BATCH_PROGRESS, [`batch:${id}`], [ok ? 1 : 0])) as [string, string, string] | null
    if (!r) return undefined
    return {
      pending: 0,
      failed: Number(r[0]),
      next: r[1] ? decode<JobSpec>(r[1]) : undefined,
      allowFailures: r[2] === '1',
    }
  }

  // ── failed store, stats ────────────────────────────────────────────────────────────────────────────

  async failed(): Promise<FailedJob[]> {
    const ids = (await this.redis.send('ZRANGE', [this.redis.key('failed:index'), 0, -1])) as string[]
    if (!ids.length) return []
    const values = (await this.redis.send('HMGET', [this.redis.key('failed'), ...ids])) as (string | null)[]
    return values.flatMap((v) => (v ? [decode<FailedJob>(v) as FailedJob] : []))
  }

  async forget(id: string): Promise<boolean> {
    const removed = Number(await this.redis.send('HDEL', [this.redis.key('failed'), id]))
    await this.redis.send('ZREM', [this.redis.key('failed:index'), id])
    return removed > 0
  }

  /** Queue a failed job again, from its first attempt. */
  async retryFailed(id: string): Promise<boolean> {
    const raw = (await this.redis.send('HGET', [this.redis.key('failed'), id])) as string | null
    if (!raw) return false
    const { envelope } = decode<FailedJob>(raw) as FailedJob
    await this.push({ ...envelope, attempt: 0, unique: undefined })
    await this.forget(id)
    return true
  }

  /** Queues that ever had a job pushed. */
  async queues(): Promise<string[]> {
    return ((await this.redis.send('SMEMBERS', [this.redis.key('queues')])) as string[]).sort()
  }

  async stats(queue: string) {
    let waiting = 0
    let active = 0
    let oldest: number | undefined
    for (const band of BANDS) {
      const key = this.redis.key(this.stream(queue, band))
      const length = Number(await this.redis.send('XLEN', [key]))
      const pending = await this.redis.send('XPENDING', [key, GROUP]).catch(() => null)
      const busy = Array.isArray(pending) ? Number(pending[0]) : 0
      waiting += length - busy
      active += busy
      const first = (await this.redis.send('XRANGE', [key, '-', '+', 'COUNT', 1])) as [string, unknown][] | null
      const at = first?.[0] ? Number(first[0][0].split('-')[0]) : undefined
      if (at !== undefined && (oldest === undefined || at < oldest)) oldest = at
    }
    const delayed = Number(await this.redis.send('ZCARD', [this.redis.key(this.delayedKey(queue))]))
    const failed = (await this.failed()).filter((f) => f.envelope.queue === queue).length
    return { queue, waiting, active, delayed, failed, oldestAgeMs: oldest === undefined ? 0 : this.now() - oldest }
  }

  /** Delete the waiting and delayed jobs of `queue` (running jobs finish; the failed store is kept). */
  async clear(queue: string): Promise<void> {
    await this.redis.send('DEL', [
      ...BANDS.map((b) => this.redis.key(this.stream(queue, b))),
      this.redis.key(this.delayedKey(queue)),
    ])
  }
}

const member = (band: Band, envelope: Envelope) => `${band[0]}${encode(envelope)}`
