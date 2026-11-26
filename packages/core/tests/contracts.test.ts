import { describe, expect, test } from 'bun:test'
import {
  Application,
  Cache,
  Lock,
  LockTimeoutError,
  MemoryCache,
  MemoryLock,
  MemoryRateLimiter,
  MemorySessionStore,
  parseRate,
  RateLimiter,
  SessionStore,
  TooManyRequestsError,
} from '../src'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Cache (memory)', () => {
  test('get / set / has / forget, ttl, values cloned (bigint and Date supported)', async () => {
    const cache = new MemoryCache()
    const value = { rate: 4925n, at: new Date('2027-05-14T00:00:00Z') }
    await cache.set('fx:EUR:MGA', value, '50ms')
    value.rate = 1n // mutating the original does not change the cached copy
    expect(await cache.get('fx:EUR:MGA')).toEqual({ rate: 4925n, at: new Date('2027-05-14T00:00:00Z') })
    expect(await cache.has('fx:EUR:MGA')).toBe(true)
    await sleep(70)
    expect(await cache.get('fx:EUR:MGA')).toBeUndefined()
    await cache.set('k', 1)
    await cache.forget('k')
    expect(await cache.has('k')).toBe(false)
  })

  test('remember: concurrent misses run the function once', async () => {
    const cache = new MemoryCache()
    let calls = 0
    const slow = async () => {
      calls++
      await sleep(20)
      return 'operators'
    }
    const results = await Promise.all(
      Array.from({ length: 10 }, () => cache.remember('operators:verified', '10m', slow)),
    )
    expect(results.every((r) => r === 'operators')).toBe(true)
    expect(calls).toBe(1)
    expect(await cache.remember('operators:verified', '10m', slow)).toBe('operators')
    expect(calls).toBe(1)
  })

  test('flexible: fresh → cached; stale → old value now, refreshed in the background', async () => {
    const cache = new MemoryCache()
    let n = 0
    const fn = async () => ++n
    expect(await cache.flexible('stats', ['30ms', '1s'], fn)).toBe(1)
    expect(await cache.flexible('stats', ['30ms', '1s'], fn)).toBe(1)
    await sleep(40)
    expect(await cache.flexible('stats', ['30ms', '1s'], fn)).toBe(1) // stale: served, refresh started
    await sleep(10)
    expect(await cache.flexible('stats', ['30ms', '1s'], fn)).toBe(2)
  })

  test('increment / decrement; tags flush only their keys', async () => {
    const cache = new MemoryCache()
    expect([await cache.increment('hits'), await cache.increment('hits', 5), await cache.decrement('hits')]).toEqual([
      1, 6, 5,
    ])
    await cache.tags(['operators']).set('op:1', 'a')
    await cache.set('other', 'b')
    await cache.tags(['operators']).flush()
    expect([await cache.has('op:1'), await cache.has('other')]).toEqual([false, true])
    await cache.flush()
    expect(await cache.has('other')).toBe(false)
  })
})

describe('Lock (memory)', () => {
  test('one holder at a time; released only by its owner; expires', async () => {
    const lock = new MemoryLock()
    const a = await lock.acquire('payout:op1', '40ms')
    expect(a).not.toBeNull()
    expect(await lock.acquire('payout:op1', '1s')).toBeNull()
    await sleep(50)
    const b = await lock.acquire('payout:op1', '1s') // a expired
    expect(b).not.toBeNull()
    await a?.release() // a's token is stale: must not release b's lock
    expect(await lock.acquire('payout:op1', '1s')).toBeNull()
    await b?.release()
    expect(await lock.acquire('payout:op1', '1s')).not.toBeNull()
  })

  test('run(): serialises concurrent work; throws LockTimeoutError when wait elapses', async () => {
    const lock = new MemoryLock()
    const order: string[] = []
    const job = (name: string) =>
      lock.run('payout:op2', { ttl: '1s', wait: '1s' }, async () => {
        order.push(`${name} start`)
        await sleep(20)
        order.push(`${name} end`)
      })
    await Promise.all([job('a'), job('b')])
    expect(order).toEqual(['a start', 'a end', 'b start', 'b end'])
    const held = await lock.acquire('busy', '1s')
    await expect(lock.run('busy', { ttl: '1s', wait: '50ms' }, () => 1)).rejects.toBeInstanceOf(LockTimeoutError)
    await held?.release()
  })
})

describe('RateLimiter (memory)', () => {
  test('parseRate', () => {
    expect(parseRate('5/min')).toEqual({ max: 5, windowMs: 60_000 })
    expect(parseRate('3/10min')).toEqual({ max: 3, windowMs: 600_000 })
    expect(parseRate('20/hour')).toEqual({ max: 20, windowMs: 3_600_000 })
    expect(parseRate({ max: 2, window: '30s' })).toEqual({ max: 2, windowMs: 30_000 })
    expect(() => parseRate('lots')).toThrow(/Invalid rate/)
  })

  test('sliding window, attempt, enforce (429 with retryAfter), reset', async () => {
    const limiter = new MemoryRateLimiter()
    const r1 = await limiter.hit('login:ada', '2/min')
    const r2 = await limiter.hit('login:ada', '2/min')
    const r3 = await limiter.hit('login:ada', '2/min')
    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, false])
    expect(r3.retryAfter).toBeGreaterThan(55)
    let sent = 0
    expect(await limiter.attempt('wa:+261', '1/hour', () => sent++)).toBe(true)
    expect(await limiter.attempt('wa:+261', '1/hour', () => sent++)).toBe(false)
    expect(sent).toBe(1)
    await expect(limiter.enforce('login:ada', '2/min')).rejects.toBeInstanceOf(TooManyRequestsError)
    await limiter.reset('login:ada')
    expect((await limiter.hit('login:ada', '2/min')).allowed).toBe(true)
  })
})

describe('SessionStore (memory) and default bindings', () => {
  test('read / write / destroy', async () => {
    const store = new MemorySessionStore()
    await store.write('s1', { userId: 'u1', flash: { success: 'Saved' } }, '14d')
    expect(await store.read('s1')).toEqual({ userId: 'u1', flash: { success: 'Saved' } })
    await store.destroy('s1')
    expect(await store.read('s1')).toBeUndefined()
  })

  test('the app binds memory drivers by default (one per app)', () => {
    const app = new Application()
    expect(app.resolve(Cache)).toBeInstanceOf(MemoryCache)
    expect(app.resolve(Lock)).toBeInstanceOf(MemoryLock)
    expect(app.resolve(RateLimiter)).toBeInstanceOf(MemoryRateLimiter)
    expect(app.resolve(SessionStore)).toBeInstanceOf(MemorySessionStore)
    expect(app.resolve(Cache)).toBe(app.createScope().resolve(Cache))
  })
})
