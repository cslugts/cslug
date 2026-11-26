import { afterAll, describe, expect, test } from 'bun:test'
import { MemoryCache, MemoryLock, MemoryRateLimiter, MemorySessionStore } from '@cslug/core'
import { decode, encode, Redis, RedisCache, RedisLock, RedisRateLimiter, RedisSessionStore } from '../src'
import { cacheContract, lockContract, rateLimiterContract, sessionStoreContract } from './contract'

const url = process.env.REDIS_URL
// every test file gets its own prefix in its own database (REDIS_URL, db 15 locally); nothing else is touched
const prefix = `cslug-test:${process.pid}:${Math.random().toString(36).slice(2, 8)}:`
const redis = url ? new Redis(url, prefix) : undefined
let n = 0
const scoped = () => (redis as Redis).withPrefix(`${++n}:`)

afterAll(async () => {
  if (!redis) return
  const keys: string[] = []
  for await (const k of redis.scan('*')) keys.push(k)
  if (keys.length) await redis.send('DEL', keys)
  redis.close()
})

cacheContract('memory', () => new MemoryCache())
lockContract('memory', () => new MemoryLock())
rateLimiterContract('memory', () => new MemoryRateLimiter())
sessionStoreContract('memory', () => new MemorySessionStore())

if (redis) {
  cacheContract('redis', () => new RedisCache(scoped()))
  lockContract('redis', () => new RedisLock(scoped()))
  rateLimiterContract('redis', () => new RedisRateLimiter(scoped()))
  sessionStoreContract('redis', () => new RedisSessionStore(scoped()))
}

describe.skipIf(!redis)('Redis (real server)', () => {
  test('flush() only removes this cache (its prefix), not other keys in the database', async () => {
    const r = scoped()
    await r.send('SET', [r.key('foreign'), 'keep'])
    const cache = new RedisCache(r)
    await cache.set('mine', 1)
    await cache.flush()
    expect(await r.send('GET', [r.key('foreign')])).toBe('keep')
    expect(await cache.has('mine')).toBe(false)
  })

  test('Lua scripts reload on NOSCRIPT (a restarted Redis)', async () => {
    const r = scoped()
    const lock = new RedisLock(r)
    await (await lock.acquire('warm', '1s'))?.release() // loads the release script
    const h = await lock.acquire('x', '1s')
    // as if Redis restarted: our cached hashes point to scripts it no longer has (SCRIPT FLUSH would affect
    // every other user of this server)
    const shas = (r as unknown as { shas: Map<string, string> }).shas
    expect(shas.size).toBe(1)
    for (const k of shas.keys()) shas.set(k, '0000000000000000000000000000000000000000')
    await h?.release()
    expect(await lock.acquire('x', '1s')).not.toBeNull()
  })

  test('a dedicated connection fails fast when closed (spike c)', async () => {
    const d = (redis as Redis).dedicated()
    const blocked = d.send('BLPOP', [d.key('never'), 5]).then(
      () => 'resolved',
      () => 'rejected',
    )
    await Bun.sleep(50)
    const started = Date.now()
    d.close()
    expect(await blocked).toBe('rejected')
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('encoding', () => {
  test('bigint and Date round-trip; plain objects that look similar are not confused', () => {
    const v = { a: 1n, d: new Date('2027-01-01T00:00:00Z'), o: { $bigint: '1', other: true } }
    expect(decode(encode(v))).toEqual(v)
  })
})
