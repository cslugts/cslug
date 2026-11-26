import { afterEach, describe, expect, test } from 'bun:test'
import {
  Application,
  Cache,
  HEALTH_CHECKS,
  type HealthCheck,
  Lock,
  Logger,
  MemoryCache,
  RateLimiter,
  SessionStore,
} from '@cslug/core'
import { Redis, RedisCache, RedisLock, RedisProvider, RedisRateLimiter, RedisSessionStore } from '../src'

const url = process.env.REDIS_URL
let app: Application | undefined
afterEach(async () => {
  await app?.shutdown().catch(() => {})
  app = undefined
})
const make = (configs: Record<string, unknown>) => {
  app = new Application({ configs }).useProviders([RedisProvider])
  app.singleton(Logger, () => Logger.null())
  return app
}

describe.skipIf(!url)('RedisProvider', () => {
  test('binds the Redis drivers, the prefix from cache.prefix, and a health check', async () => {
    const a = await make({
      redis: { connections: { default: { url } }, prefix: 'cslug-ptest:' },
      cache: { prefix: 'app:' },
    }).start()
    expect(a.resolve(Cache)).toBeInstanceOf(RedisCache)
    expect(a.resolve(Lock)).toBeInstanceOf(RedisLock)
    expect(a.resolve(RateLimiter)).toBeInstanceOf(RedisRateLimiter)
    expect(a.resolve(SessionStore)).toBeInstanceOf(RedisSessionStore)
    await a.resolve(Cache).set('k', 1, '5s')
    expect(await a.resolve(Redis).send('EXISTS', ['cslug-ptest:app:cache:k'])).toBe(1)
    await a.resolve(Cache).flush()
    const checks = a.tagged<HealthCheck>(HEALTH_CHECKS)
    expect(checks.map((c) => c.name)).toEqual(['redis'])
    await checks[0]?.check()
  })

  test("cache.default 'memory' and session.store 'memory' keep the memory drivers", async () => {
    const a = await make({
      redis: { connections: { default: { url } } },
      cache: { default: 'memory' },
      session: { store: 'memory' },
    }).start()
    expect(a.resolve(Cache)).toBeInstanceOf(MemoryCache)
    expect(a.resolve(SessionStore)).not.toBeInstanceOf(RedisSessionStore)
  })
})

describe('RedisProvider without a server', () => {
  test('a missing connection is a config error; an unreachable server fails boot', async () => {
    await expect(make({}).start()).rejects.toThrow('config/redis.ts has no connection "default"')
    await expect(
      make({ redis: { connections: { default: { url: 'redis://127.0.0.1:1', connectTimeout: 200 } } } }).start(),
    ).rejects.toThrow('did not answer within 200 ms')
  }, 15_000)
})
