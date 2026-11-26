import {
  Cache,
  CslugError,
  HEALTH_CHECKS,
  healthCheck,
  Lock,
  RateLimiter,
  ServiceProvider,
  SessionStore,
} from '@cslug/core'
import { RedisCache, RedisLock, RedisRateLimiter, RedisSessionStore } from './drivers'
import { Redis, type RedisConfig } from './redis'

/** All named connections: `resolve(RedisConnections).get('default')`. */
export class RedisConnections {
  private readonly open = new Map<string, Redis>()
  constructor(private readonly config: RedisConfig) {}

  get(name = 'default'): Redis {
    let r = this.open.get(name)
    if (!r) {
      const c = this.config.connections?.[name]
      if (!c?.url)
        throw new CslugError(
          'redis.no_connection',
          `config/redis.ts has no connection "${name}" (connections.${name}.url)`,
        )
      r = new Redis(c.url, c.prefix ?? this.config.prefix ?? '', { connectTimeout: c.connectTimeout })
      this.open.set(name, r)
    }
    return r
  }
  closeAll(): void {
    for (const r of this.open.values()) r.close()
    this.open.clear()
  }
}

/**
 * Binds `Redis` (the default connection) and Redis drivers for core's `Cache`, `Lock`, `RateLimiter` and
 * `SessionStore`, unless config picks `memory` (`cache.default`, `session.store`). Adds the `redis` health check.
 */
export class RedisProvider extends ServiceProvider {
  register() {
    const config = this.app.config<RedisConfig | undefined>('redis') ?? {}
    this.app.singleton(RedisConnections, () => new RedisConnections(config))
    this.app.singleton(Redis, (c) => c.resolve(RedisConnections).get('default'))
    const cache = this.app.config<
      | { default?: string; prefix?: string; stores?: Record<string, { driver?: string; connection?: string }> }
      | undefined
    >('cache')
    const store = cache?.stores?.[cache.default ?? 'redis']
    const driver = store?.driver ?? cache?.default ?? 'redis'
    const connection = (c: { resolve: (t: typeof RedisConnections) => RedisConnections }) => {
      const base = c.resolve(RedisConnections).get(store?.connection ?? 'default')
      return base.withPrefix(cache?.prefix ?? '')
    }
    if (driver === 'redis') {
      this.app.singleton(Cache, (c) => new RedisCache(connection(c)))
      this.app.singleton(Lock, (c) => new RedisLock(connection(c)))
      this.app.singleton(RateLimiter, (c) => new RedisRateLimiter(connection(c)))
    }
    if ((this.app.config<string | undefined>('session.store') ?? 'redis') === 'redis') {
      this.app.singleton(SessionStore, (c) => new RedisSessionStore(connection(c)))
    }
    const check = healthCheck('redis')
    this.app.singleton(check, (c) => ({ name: 'redis', check: () => c.resolve(Redis).ping() }))
    this.app.tag([check], HEALTH_CHECKS)
  }

  async boot() {
    try {
      await this.app.resolve(Redis).ping()
    } catch (error) {
      // shutdown() is not called for a provider whose boot failed: don't leave a reconnecting client behind
      this.app.resolve(RedisConnections).closeAll()
      throw error
    }
  }

  shutdown() {
    this.app.resolve(RedisConnections).closeAll()
  }
}
