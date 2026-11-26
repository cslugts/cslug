/**
 * Contracts that other packages implement. Core binds in-memory versions (single process: development and
 * tests); `@cslug/redis` binds Redis versions when its provider is listed.
 */
import { type Duration, parseDuration } from './duration'
import { CslugError, TooManyRequestsError } from './errors'

// ── Cache ────────────────────────────────────────────────────────────────────────────────────────────
export abstract class Cache {
  abstract get<T>(key: string): Promise<T | undefined>
  /** Store a value (JSON-like, bigint and Date supported). Without `ttl` it does not expire. */
  abstract set(key: string, value: unknown, ttl?: Duration): Promise<void>
  abstract has(key: string): Promise<boolean>
  abstract forget(key: string): Promise<void>
  /** Atomic counter; returns the new value. `ttl` applies when the key is created. */
  abstract increment(key: string, by?: number, ttl?: Duration): Promise<number>
  /** Remove everything this cache (or tag set) holds. */
  abstract flush(): Promise<void>
  /** A view whose `flush()` removes only the keys written through it. */
  abstract tags(tags: readonly string[]): Cache

  private readonly inflight = new Map<string, Promise<unknown>>()

  decrement(key: string, by = 1): Promise<number> {
    return this.increment(key, -by)
  }

  /** Read through: concurrent misses for the same key wait for one `fn` (no stampede). */
  async remember<T>(key: string, ttl: Duration | undefined, fn: () => T | Promise<T>): Promise<T> {
    const hit = await this.get<T>(key)
    if (hit !== undefined) return hit
    const running = this.inflight.get(key) as Promise<T> | undefined
    if (running) return running
    const work = (async () => {
      try {
        const value = await fn()
        await this.set(key, value, ttl)
        return value
      } finally {
        this.inflight.delete(key)
      }
    })()
    this.inflight.set(key, work)
    return work
  }

  /** Serve a value while it is `fresh`; until `stale`, serve the old value and refresh in the background. */
  async flexible<T>(key: string, [fresh, stale]: [Duration, Duration], fn: () => T | Promise<T>): Promise<T> {
    const entry = await this.get<{ value: T; at: number }>(`${key}:flexible`)
    const age = entry ? Date.now() - entry.at : Number.POSITIVE_INFINITY
    const store = async () => {
      const value = await fn()
      await this.set(`${key}:flexible`, { value, at: Date.now() }, stale)
      return value
    }
    if (entry && age < parseDuration(fresh)) return entry.value
    if (entry && age < parseDuration(stale)) {
      if (!this.inflight.has(key)) {
        const refresh = store()
          .catch(() => undefined)
          .finally(() => this.inflight.delete(key))
        this.inflight.set(key, refresh)
      }
      return entry.value
    }
    return store()
  }
}

type Entry = { value: unknown; expires: number | null }

/** In-memory cache for one process. Values are cloned on write and read, as a real store would. */
export class MemoryCache extends Cache {
  constructor(
    private readonly store = new Map<string, Entry>(),
    private readonly tagIndex = new Map<string, Set<string>>(),
    private readonly ownTags: readonly string[] = [],
  ) {
    super()
  }

  private live(key: string): Entry | undefined {
    const e = this.store.get(key)
    if (e && e.expires !== null && e.expires <= Date.now()) {
      this.store.delete(key)
      return undefined
    }
    return e
  }

  async get<T>(key: string): Promise<T | undefined> {
    const e = this.live(key)
    return e ? (structuredClone(e.value) as T) : undefined
  }

  async set(key: string, value: unknown, ttl?: Duration): Promise<void> {
    this.store.set(key, {
      value: structuredClone(value),
      expires: ttl === undefined ? null : Date.now() + parseDuration(ttl),
    })
    for (const tag of this.ownTags) {
      const keys = this.tagIndex.get(tag) ?? new Set<string>()
      keys.add(key)
      this.tagIndex.set(tag, keys)
    }
  }

  async has(key: string): Promise<boolean> {
    return this.live(key) !== undefined
  }

  async forget(key: string): Promise<void> {
    this.store.delete(key)
  }

  async increment(key: string, by = 1, ttl?: Duration): Promise<number> {
    const e = this.live(key)
    const next = (typeof e?.value === 'number' ? e.value : 0) + by
    if (e) e.value = next
    else await this.set(key, next, ttl)
    return next
  }

  async flush(): Promise<void> {
    if (!this.ownTags.length) {
      this.store.clear()
      this.tagIndex.clear()
      return
    }
    for (const tag of this.ownTags) {
      for (const key of this.tagIndex.get(tag) ?? []) this.store.delete(key)
      this.tagIndex.delete(tag)
    }
  }

  tags(tags: readonly string[]): Cache {
    return new MemoryCache(this.store, this.tagIndex, tags)
  }
}

// ── Lock ─────────────────────────────────────────────────────────────────────────────────────────────
/** Raised when `lock.run(…, { wait })` could not get the lock in time. */
export class LockTimeoutError extends CslugError {
  constructor(key: string) {
    super('lock.timeout', `Could not acquire lock "${key}" in time`)
  }
}

export type LockHandle = { key: string; token: string; release(): Promise<void> }

/**
 * Cluster-wide (with Redis) mutual exclusion for work that must not run twice at once. Released only by its
 * owner (by token); expires after `ttl` so a crashed holder cannot block forever.
 */
export abstract class Lock {
  /** Try once; null if someone else holds it. */
  abstract acquire(key: string, ttl: Duration): Promise<LockHandle | null>

  /** Wait up to `wait` for the lock, run `fn`, always release. */
  async run<T>(key: string, options: { ttl: Duration; wait?: Duration }, fn: () => T | Promise<T>): Promise<T> {
    const deadline = Date.now() + (options.wait === undefined ? 0 : parseDuration(options.wait))
    let handle = await this.acquire(key, options.ttl)
    while (!handle && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      handle = await this.acquire(key, options.ttl)
    }
    if (!handle) throw new LockTimeoutError(key)
    try {
      return await fn()
    } finally {
      await handle.release()
    }
  }
}

export class MemoryLock extends Lock {
  private readonly held = new Map<string, { token: string; expires: number }>()

  async acquire(key: string, ttl: Duration): Promise<LockHandle | null> {
    const current = this.held.get(key)
    if (current && current.expires > Date.now()) return null
    const token = crypto.randomUUID()
    this.held.set(key, { token, expires: Date.now() + parseDuration(ttl) })
    return {
      key,
      token,
      release: async () => {
        if (this.held.get(key)?.token === token) this.held.delete(key)
      },
    }
  }
}

// ── RateLimiter ──────────────────────────────────────────────────────────────────────────────────────
export type RateLimit = string | { max: number; window: Duration }
export type RateLimitResult = { allowed: boolean; remaining: number; retryAfter: number }

const UNIT_WINDOWS: Record<string, string> = {
  s: '1s',
  sec: '1s',
  second: '1s',
  m: '1m',
  min: '1m',
  minute: '1m',
  h: '1h',
  hour: '1h',
  d: '1d',
  day: '1d',
}

/** `'5/min'`, `'3/10min'`, `'20/hour'`, `'30/s'` → `{ max, windowMs }`. */
export function parseRate(limit: RateLimit): { max: number; windowMs: number } {
  if (typeof limit !== 'string') return { max: limit.max, windowMs: parseDuration(limit.window) }
  const m = /^(\d+)\s*\/\s*(\d*)\s*([a-z]+)$/i.exec(limit.trim())
  const unit = m ? UNIT_WINDOWS[(m[3] as string).toLowerCase()] : undefined
  if (!m || !unit)
    throw new CslugError('rate.invalid', `Invalid rate "${limit}" (use e.g. "5/min", "3/10min", "20/hour")`)
  return { max: Number(m[1]), windowMs: parseDuration(unit) * (m[2] ? Number(m[2]) : 1) }
}

/** Sliding-window rate limiting. */
export abstract class RateLimiter {
  /** Count one hit for `key`; tells whether it is allowed. */
  abstract hit(key: string, limit: RateLimit): Promise<RateLimitResult>
  /** Clear a key (e.g. after a successful login). */
  abstract reset(key: string): Promise<void>

  /** Run `fn` if allowed; returns false (without running it) when the limit is reached. */
  async attempt(key: string, limit: RateLimit, fn: () => unknown): Promise<boolean> {
    if (!(await this.hit(key, limit)).allowed) return false
    await fn()
    return true
  }

  /** Throw `TooManyRequestsError` (429, with Retry-After) when the limit is reached. */
  async enforce(key: string, limit: RateLimit): Promise<RateLimitResult> {
    const result = await this.hit(key, limit)
    if (!result.allowed) throw new TooManyRequestsError(result.retryAfter)
    return result
  }
}

export class MemoryRateLimiter extends RateLimiter {
  private readonly hits = new Map<string, number[]>()

  async hit(key: string, limit: RateLimit): Promise<RateLimitResult> {
    const { max, windowMs } = parseRate(limit)
    const now = Date.now()
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - windowMs)
    const allowed = recent.length < max
    if (allowed) recent.push(now)
    this.hits.set(key, recent)
    const oldest = recent[0] ?? now
    return {
      allowed,
      remaining: Math.max(0, max - recent.length),
      retryAfter: allowed ? 0 : Math.ceil((oldest + windowMs - now) / 1000),
    }
  }

  async reset(key: string): Promise<void> {
    this.hits.delete(key)
  }
}

// ── SessionStore ─────────────────────────────────────────────────────────────────────────────────────
export type SessionData = Record<string, unknown>

/** Where HTTP sessions live (the cookie only carries the id). */
export abstract class SessionStore {
  abstract read(id: string): Promise<SessionData | undefined>
  abstract write(id: string, data: SessionData, ttl: Duration): Promise<void>
  abstract destroy(id: string): Promise<void>
}

export class MemorySessionStore extends SessionStore {
  private readonly cache = new MemoryCache()

  read(id: string): Promise<SessionData | undefined> {
    return this.cache.get<SessionData>(`session:${id}`)
  }
  write(id: string, data: SessionData, ttl: Duration): Promise<void> {
    return this.cache.set(`session:${id}`, data, ttl)
  }
  destroy(id: string): Promise<void> {
    return this.cache.forget(`session:${id}`)
  }
}
