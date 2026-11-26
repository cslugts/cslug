import {
  Cache,
  type Duration,
  Lock,
  type LockHandle,
  parseDuration,
  parseRate,
  type RateLimit,
  RateLimiter,
  type RateLimitResult,
  type SessionData,
  SessionStore,
} from '@cslug/core'
import { decode, encode, type Redis } from './redis'

const ms = (ttl: Duration) => Math.max(1, Math.round(parseDuration(ttl)))

// ── Cache ────────────────────────────────────────────────────────────────────────────────────────────
const INCREMENT = `
local v = redis.call('INCRBY', KEYS[1], ARGV[1])
if tonumber(ARGV[2]) > 0 and redis.call('PTTL', KEYS[1]) == -1 and v == tonumber(ARGV[1]) then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return v`

/** Cache in Redis: `cache:<key>`. Tags keep a set of their keys, so `tags([...]).flush()` removes only those. */
export class RedisCache extends Cache {
  constructor(
    private readonly redis: Redis,
    private readonly ownTags: readonly string[] = [],
  ) {
    super()
  }
  private k = (key: string) => `cache:${key}`

  async get<T>(key: string): Promise<T | undefined> {
    const raw = (await this.redis.send('GET', [this.redis.key(this.k(key))])) as string | null
    // counters are stored as plain integers (INCRBY)
    if (raw !== null && /^-?\d+$/.test(raw)) return Number(raw) as T
    return decode<T>(raw)
  }
  async set(key: string, value: unknown, ttl?: Duration): Promise<void> {
    const args: (string | number)[] = [this.redis.key(this.k(key)), encode(value)]
    if (ttl !== undefined) args.push('PX', ms(ttl))
    await this.redis.send('SET', args)
    await this.index(key)
  }
  async has(key: string): Promise<boolean> {
    return (await this.redis.send('EXISTS', [this.redis.key(this.k(key))])) === 1
  }
  async forget(key: string): Promise<void> {
    await this.redis.send('DEL', [this.redis.key(this.k(key))])
  }
  async increment(key: string, by = 1, ttl?: Duration): Promise<number> {
    const v = Number(await this.redis.eval(INCREMENT, [this.k(key)], [by, ttl === undefined ? 0 : ms(ttl)]))
    await this.index(key)
    return v
  }
  async flush(): Promise<void> {
    if (!this.ownTags.length) {
      // only this app's cache keys (the prefix), never the whole database
      const keys: string[] = []
      for await (const k of this.redis.scan('cache:*')) keys.push(k)
      for await (const k of this.redis.scan('cache-tag:*')) keys.push(k)
      for (let i = 0; i < keys.length; i += 500) await this.redis.send('UNLINK', keys.slice(i, i + 500))
      return
    }
    for (const tag of this.ownTags) {
      const set = this.redis.key(`cache-tag:${tag}`)
      const keys = (await this.redis.send('SMEMBERS', [set])) as string[]
      if (keys.length)
        await this.redis.send(
          'UNLINK',
          keys.map((k) => this.redis.key(this.k(k))),
        )
      await this.redis.send('UNLINK', [set])
    }
  }
  tags(tags: readonly string[]): Cache {
    return new RedisCache(this.redis, tags)
  }
  private async index(key: string): Promise<void> {
    for (const tag of this.ownTags) await this.redis.send('SADD', [this.redis.key(`cache-tag:${tag}`), key])
  }
}

// ── Lock ─────────────────────────────────────────────────────────────────────────────────────────────
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`

/** `SET lock:<key> <token> NX PX ttl`; released only by its owner (Lua compare-and-delete). */
export class RedisLock extends Lock {
  constructor(private readonly redis: Redis) {
    super()
  }
  async acquire(key: string, ttl: Duration): Promise<LockHandle | null> {
    const token = crypto.randomUUID()
    const ok = await this.redis.send('SET', [this.redis.key(`lock:${key}`), token, 'NX', 'PX', ms(ttl)])
    if (ok !== 'OK') return null
    return {
      key,
      token,
      release: async () => {
        await this.redis.eval(RELEASE, [`lock:${key}`], [token])
      },
    }
  }
}

// ── RateLimiter ──────────────────────────────────────────────────────────────────────────────────────
// sliding window: a sorted set of hit times; returns { allowed, count, oldest }
const HIT = `
local now, window, max = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
local allowed = 0
if count < max then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  count = count + 1
  allowed = 1
end
redis.call('PEXPIRE', KEYS[1], window)
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return { allowed, count, oldest[2] or now }`

export class RedisRateLimiter extends RateLimiter {
  constructor(private readonly redis: Redis) {
    super()
  }
  async hit(key: string, limit: RateLimit): Promise<RateLimitResult> {
    const { max, windowMs } = parseRate(limit)
    const now = Date.now()
    const [allowed, count, oldest] = (await this.redis.eval(
      HIT,
      [`rate:${key}`],
      [now, windowMs, max, `${now}-${crypto.randomUUID()}`],
    )) as [number, number, string | number]
    return {
      allowed: allowed === 1,
      remaining: Math.max(0, max - Number(count)),
      retryAfter: allowed === 1 ? 0 : Math.ceil((Number(oldest) + windowMs - now) / 1000),
    }
  }
  async reset(key: string): Promise<void> {
    await this.redis.send('DEL', [this.redis.key(`rate:${key}`)])
  }
}

// ── SessionStore ─────────────────────────────────────────────────────────────────────────────────────
export class RedisSessionStore extends SessionStore {
  constructor(private readonly redis: Redis) {
    super()
  }
  async read(id: string): Promise<SessionData | undefined> {
    return decode<SessionData>((await this.redis.send('GET', [this.redis.key(`session:${id}`)])) as string | null)
  }
  async write(id: string, data: SessionData, ttl: Duration): Promise<void> {
    await this.redis.send('SET', [this.redis.key(`session:${id}`), encode(data), 'PX', ms(ttl)])
  }
  async destroy(id: string): Promise<void> {
    await this.redis.send('DEL', [this.redis.key(`session:${id}`)])
  }
}
