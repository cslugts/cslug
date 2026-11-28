# Cache, locks & rate limits

Four contracts live in `@cslug/core`: `Cache`, `Lock`, `RateLimiter` and `SessionStore`. Core binds in-memory
drivers (fine for one process and for tests); with `RedisProvider` listed (`@cslug/redis`, in every preset), Redis
drivers replace them, shared by every process. Your code injects the contract and works with either.

## Cache

```ts
import { Cache, inject } from '@cslug/core'

@inject(Cache)
export class ExchangeRates {
  constructor(private cache: Cache) {}

  /** EUR→MGA etc., cached for an hour; concurrent misses fetch once. */
  rate(from: string, to: string) {
    return this.cache.remember(`fx:${from}:${to}`, '1h', async () => {
      const res = await fetch(`https://api.example-fx.com/latest?base=${from}&symbols=${to}`)
      const body = (await res.json()) as { rates: Record<string, number> }
      return body.rates[to] as number
    })
  }
}
```

| Method | |
|---|---|
| `get<T>(key)` / `set(key, value, ttl?)` / `has(key)` / `forget(key)` | Values keep `bigint` and `Date` (stored as JSON); without `ttl`, kept until forgotten |
| `remember(key, ttl, fn)` | Read-through: `fn` runs on a miss and its result is stored; concurrent misses for one key wait for one `fn` (no stampede) |
| `flexible(key, [fresh, stale], fn)` | Fresh for `fresh`; then, until `stale`, the old value is served at once while one caller refreshes it in the background |
| `increment(key, by = 1, ttl?)` / `decrement(key, by?)` | Atomic counters (the `ttl` applies when the counter is created) |
| `tags(['operators'])` | A view of the cache whose `flush()` removes only what was written through it |
| `flush()` | Everything under this app's prefix |

```ts
// stale-while-revalidate: a slow dashboard query
const stats = await this.cache.flexible('dashboard:stats', ['1m', '1h'], () => this.reports.dashboard())

// invalidate a group
await this.cache.tags(['operators']).remember(`operators:verified:${circuitId}`, '10m', () => …)
await this.cache.tags(['operators']).flush()     // after an operator changes

// a counter
const views = await this.cache.increment(`views:${circuitId}:${today}`, 1, '2d')
```

Durations are strings (`'30s'`, `'10m'`, `'1h'`, `'1d'`) or milliseconds (guide 26).

## Atomic locks

```ts
import { inject, Lock } from '@cslug/core'

@inject(Lock)
export class PayoutService {
  constructor(private lock: Lock) {}

  async payOperator(operatorId: string) {
    await this.lock.run(`payout:${operatorId}`, { ttl: '2m', wait: '10s' }, async () => {
      // only one process in the cluster runs this for an operator at a time
    })
  }

  async refreshIfFree(key: string) {
    const handle = await this.lock.acquire(`refresh:${key}`, '5m')   // null when someone holds it: skip
    if (!handle) return
    try {
      await this.refresh(key)
    } finally {
      await handle.release()
    }
  }
}
```

A lock is released by its owner only (a token), and expires after `ttl` so a crashed holder cannot block forever.
`run` waits up to `wait` (default: not at all) and throws `LockTimeoutError` after that. For changes to money and
state, prefer the **database** row lock ([guide 09](./09-database.md#locks-and-idempotency)), which also holds the
transaction; Redis locks are for "don't do this twice at once" work like API calls and cache rebuilds.

## Rate limiting

As middleware ([guide 05](./05-routing-and-middleware.md)):

```ts
r.post('/trip-request', [TripRequestController, 'store']).middleware(throttle('5/min'))
r.post('/login/link', …).middleware(throttle('3/10min', async ({ request }) => String(await request.input('email'))))
```

In code:

```ts
import { inject, Logger, RateLimiter } from '@cslug/core'

@inject(RateLimiter, WhatsappClient, Logger)
export class WhatsappSender {
  constructor(private limiter: RateLimiter, private client: WhatsappClient, private log: Logger) {}

  async send(phone: string, msg: string) {
    // runs fn when allowed; false when over the limit
    const sent = await this.limiter.attempt(`whatsapp:${phone}`, '20/hour', () => this.client.send(phone, msg))
    if (!sent) this.log.warn('whatsapp.throttled', { phone })
  }

  async check(key: string) {
    await this.limiter.enforce(key, { max: 100, window: '1d' })     // throws TooManyRequestsError (429, Retry-After)
    const { allowed, remaining, retryAfter } = await this.limiter.hit(key, '10/min')   // count one, tell me
    await this.limiter.reset(key)                                     // after a success
  }
}
```

Limits are `'5/min'`, `'3/10min'`, `'1000/day'` (`s`, `sec`, `min`, `hour`, `day` and multiples), or
`{ max, window }`. The window slides: there is no burst at the turn of a minute.

## Sessions

`SessionStore` holds the sessions of `routes/web.ts` (guide 06): Redis with `@cslug/redis`, else memory.
`session.store: 'memory'` in `config/session.ts` keeps them in memory even with Redis (one process only).

## Redis directly

For what the contracts do not cover (a leaderboard, a pub/sub channel), inject the connection:

```ts
import { inject } from '@cslug/core'
import { Redis } from '@cslug/redis'

@inject(Redis)
export class Leaderboard {
  constructor(private redis: Redis) {}

  add(operatorId: string, points: number) {
    return this.redis.send('ZINCRBY', [this.redis.key('leaderboard'), points, operatorId])   // key() adds the prefix
  }
  top(n = 10) {
    return this.redis.send('ZREVRANGE', [this.redis.key('leaderboard'), 0, n - 1, 'WITHSCORES'])
  }
}
```

`redis.eval(script, keys, args)` runs Lua (atomic multi-step updates); `redis.dedicated()` opens a separate
connection for blocking commands; `RedisConnections.get('name')` reaches another configured connection.

## Configuration

```ts
// config/redis.ts
export default defineConfig({
  connections: { default: { url: env.REDIS_URL } },
  prefix: 'app:',                         // every key of this app starts with it (several apps on one Redis)
})

// config/cache.ts
export default defineConfig({
  default: 'redis',                       // or 'memory'
  prefix: 'cache:',
  stores: { redis: { driver: 'redis', connection: 'default' }, memory: { driver: 'memory' } },
})
```

Boot pings Redis and fails if it does not answer; `/health/ready` includes a `redis` check. In tests, `testApp()`
gives each test fresh in-memory stores (rate limits, locks, cache, sessions) unless the app uses Redis ones.
