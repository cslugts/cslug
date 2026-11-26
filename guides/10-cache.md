# Cache, locks & rate limits

Backed by Redis through `Bun.redis` when `RedisProvider` is listed (`cache.default: 'memory'` keeps the
in-memory store). Without it, core's in-memory drivers are used: fine for one process and for tests.

## Cache

```ts
import { inject, Cache } from '@cslug/core'

@inject(Cache, HttpClient)
export class ExchangeRates {
  constructor(private cache: Cache, private http: HttpClient) {}

  /** EUR→MGA etc. — cached for an hour, refreshed by one caller at a time. */
  rate(from: Currency, to: Currency) {
    return this.cache.remember(`fx:${from}:${to}`, '1h', async () => {
      const res = await this.http.get(`https://api.example-fx.com/latest?base=${from}&symbols=${to}`).json<FxResponse>()
      return res.rates[to]
    })
  }
}
```

| Method | |
|---|---|
| `get<T>(key)` / `set(key, value, ttl)` / `has` / `forget` | Values are JSON with bigint and Date support |
| `remember(key, ttl, fn)` | Read-through; concurrent misses for the same key wait for one `fn` (stampede protection) |
| `flexible(key, [fresh, stale], fn)` | Serve stale while refreshing in the background |
| `increment(key, by?)` / `decrement` | Atomic counters |
| `tags(['operators']).remember(...)` / `tags(['operators']).flush()` | Group invalidation |

TTLs accept `'30s' | '10m' | '1h' | '1d'` or seconds.

## Atomic locks

```ts
import { Lock } from '@cslug/core'

@inject(Lock)
export class PayoutService {
  constructor(private lock: Lock) {}

  async payOperator(operatorId: string) {
    await this.lock.run(`payout:${operatorId}`, { ttl: '2m', wait: '10s' }, async () => {
      // only one process in the cluster runs this for an operator at a time
    })
  }
}
```

Locks are released by token (only the owner releases), expire after `ttl`, and `lock.run` throws
`LockTimeoutError` if `wait` elapses. For money state changes prefer the **database** row lock
([guide 09](./09-database.md#locks)); Redis locks are for "don't do this twice at once" work like API calls.

## Rate limiting

As middleware ([guide 05](./05-routing-and-middleware.md)):

```ts
r.post('/trip-request', [TripRequestController, 'store']).middleware(throttle('5/min'))
r.post('/login/link', …).middleware(throttle('3/10min', ({ request }) => request.input('email')))
```

In code:

```ts
import { RateLimiter } from '@cslug/core'

const ok = await this.limiter.attempt(`whatsapp:${phone}`, '20/hour', () => this.whatsapp.send(msg))
if (!ok) throw new TooManyRequestsError()
```

## Configuration

```ts
// config/cache.ts
export default defineConfig({
  default: 'redis',
  prefix: 'albastr:',
  stores: {
    redis: { driver: 'redis', connection: 'default' },
    memory: { driver: 'memory', max: 1000 },
  },
})
```
