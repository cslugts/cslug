/**
 * One behaviour for every driver of core's contracts: the same suite runs against the memory drivers (core) and
 * the Redis drivers, so they cannot drift apart.
 */
import { describe, expect, test } from 'bun:test'
import { type Cache, type Lock, LockTimeoutError, type RateLimiter, type SessionStore } from '@cslug/core'

export function cacheContract(name: string, make: () => Cache) {
  describe(`Cache contract: ${name}`, () => {
    test('get/set/has/forget; values keep bigint, Date, nesting', async () => {
      const cache = make()
      const value = { amount: 220000n, at: new Date('2027-05-14T10:00:00Z'), tags: ['a'], nested: { n: 1, s: '42' } }
      await cache.set('v', value)
      expect(await cache.get('v')).toEqual(value)
      expect(await cache.has('v')).toBe(true)
      expect(await cache.get('missing')).toBeUndefined()
      await cache.set('str', '123')
      expect(await cache.get('str')).toBe('123')
      await cache.forget('v')
      expect(await cache.has('v')).toBe(false)
    })

    test('ttl expires', async () => {
      const cache = make()
      await cache.set('short', 1, 60)
      expect(await cache.get('short')).toBe(1)
      await Bun.sleep(90)
      expect(await cache.get('short')).toBeUndefined()
    })

    test('increment/decrement are atomic; ttl only on creation', async () => {
      const cache = make()
      await Promise.all(Array.from({ length: 50 }, () => cache.increment('hits')))
      expect(await cache.get('hits')).toBe(50)
      expect(await cache.decrement('hits', 10)).toBe(40)
      expect(await cache.increment('ttl-counter', 1, 80)).toBe(1)
      await Bun.sleep(40)
      expect(await cache.increment('ttl-counter', 1, 80)).toBe(2)
      await Bun.sleep(60)
      expect(await cache.get('ttl-counter')).toBeUndefined() // the first ttl still applied
    })

    test('remember: one producer for concurrent misses', async () => {
      const cache = make()
      let calls = 0
      const produce = async () => {
        calls++
        await Bun.sleep(20)
        return { rate: 4800n }
      }
      const results = await Promise.all(Array.from({ length: 10 }, () => cache.remember('fx', '1m', produce)))
      expect(calls).toBe(1)
      expect(results.every((r) => r.rate === 4800n)).toBe(true)
      expect(await cache.remember('fx', '1m', produce)).toEqual({ rate: 4800n })
      expect(calls).toBe(1)
    })

    test('tags: flush removes only the tagged keys; flush() removes this cache', async () => {
      const cache = make()
      await cache.tags(['operators']).set('op:1', 'a')
      await cache.tags(['operators', 'public']).set('op:2', 'b')
      await cache.set('other', 'c')
      await cache.tags(['operators']).flush()
      expect([await cache.has('op:1'), await cache.has('op:2'), await cache.get('other')]).toEqual([false, false, 'c'])
      await cache.flush()
      expect(await cache.has('other')).toBe(false)
    })
  })
}

export function lockContract(name: string, make: () => Lock) {
  describe(`Lock contract: ${name}`, () => {
    test('one holder at a time; only the owner releases; expires after ttl', async () => {
      const lock = make()
      const a = await lock.acquire('payout:op1', '1s')
      expect(a).not.toBeNull()
      expect(await lock.acquire('payout:op1', '1s')).toBeNull()
      // a stale handle must not release a newer holder's lock
      const short = await lock.acquire('k2', 50)
      await Bun.sleep(80)
      const newer = await lock.acquire('k2', '1s')
      expect(newer).not.toBeNull()
      await short?.release()
      expect(await lock.acquire('k2', '1s')).toBeNull()
      await a?.release()
      expect(await lock.acquire('payout:op1', '1s')).not.toBeNull()
    })

    test('run(): serialises concurrent work; LockTimeoutError when wait elapses', async () => {
      const lock = make()
      const order: string[] = []
      await Promise.all(
        [1, 2, 3].map((i) =>
          lock.run('serial', { ttl: '5s', wait: '2s' }, async () => {
            order.push(`start${i}`)
            await Bun.sleep(30)
            order.push(`end${i}`)
          }),
        ),
      )
      for (let i = 0; i < order.length; i += 2)
        expect(order[i + 1]?.replace('end', '')).toBe(order[i]?.replace('start', ''))
      const held = await lock.acquire('busy', '5s')
      await expect(lock.run('busy', { ttl: '1s', wait: 60 }, () => 1)).rejects.toBeInstanceOf(LockTimeoutError)
      await held?.release()
    })
  })
}

export function rateLimiterContract(name: string, make: () => RateLimiter) {
  describe(`RateLimiter contract: ${name}`, () => {
    test('sliding window: allowed up to max, then retryAfter; reset', async () => {
      const limiter = make()
      const results = []
      for (let i = 0; i < 4; i++) results.push(await limiter.hit('login:a@b.c', '3/min'))
      expect(results.map((r) => [r.allowed, r.remaining])).toEqual([
        [true, 2],
        [true, 1],
        [true, 0],
        [false, 0],
      ])
      expect(results[3]?.retryAfter).toBeGreaterThan(55)
      await limiter.reset('login:a@b.c')
      expect((await limiter.hit('login:a@b.c', '3/min')).allowed).toBe(true)
    })

    test('the window slides', async () => {
      const limiter = make()
      expect((await limiter.hit('w', { max: 1, window: 80 })).allowed).toBe(true)
      expect((await limiter.hit('w', { max: 1, window: 80 })).allowed).toBe(false)
      await Bun.sleep(100)
      expect((await limiter.hit('w', { max: 1, window: 80 })).allowed).toBe(true)
    })

    test('concurrent hits never exceed max', async () => {
      const limiter = make()
      const results = await Promise.all(Array.from({ length: 30 }, () => limiter.hit('burst', '10/min')))
      expect(results.filter((r) => r.allowed).length).toBe(10)
    })
  })
}

export function sessionStoreContract(name: string, make: () => SessionStore) {
  describe(`SessionStore contract: ${name}`, () => {
    test('write/read/destroy; ttl', async () => {
      const store = make()
      await store.write('s1', { userId: 'u1', _flash: { success: 'ok' }, n: 1n }, '1m')
      expect(await store.read('s1')).toEqual({ userId: 'u1', _flash: { success: 'ok' }, n: 1n })
      await store.destroy('s1')
      expect(await store.read('s1')).toBeUndefined()
      await store.write('s2', { a: 1 }, 50)
      await Bun.sleep(80)
      expect(await store.read('s2')).toBeUndefined()
    })
  })
}
