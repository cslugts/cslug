# @cslug/redis

```ts
// config/redis.ts
export default defineConfig({ connections: { default: { url: env.REDIS_URL } }, prefix: 'app:' })
```

`RedisProvider` binds `Redis` (the default connection) and, unless `cache.default` / `session.store` say
`memory`, the Redis drivers:

| Contract | Redis |
|---|---|
| `Cache` | `cache:<key>`, JSON that keeps `bigint` and `Date`; counters are `INCRBY` (ttl on creation, in Lua); tags are sets; `flush()` deletes only this prefix (SCAN + UNLINK) |
| `Lock` | `SET lock:<key> <token> NX PX`; released by its owner only (Lua compare-and-delete) |
| `RateLimiter` | sliding window: a sorted set per key, in one Lua call (concurrent hits never exceed the limit) |
| `SessionStore` | `session:<id>` with the session lifetime |

The memory drivers in core and these pass the **same contract tests** (`packages/redis/tests/contract.ts`).

Boot pings Redis and fails after `connectTimeout` (default 5 s). The `redis` health check is in `/health/ready`.
`redis.dedicated()` opens a separate connection with `autoReconnect: false`, for blocking loops such as queue
workers (see spikes/c-redis-streams).
