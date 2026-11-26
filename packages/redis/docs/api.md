# @cslug/redis: API

| | |
|---|---|
| `Redis` | `key(k)` (prefixed), `send(cmd, args)`, `eval(script, keys, args)` (EVALSHA, reloads on NOSCRIPT, prefixes keys), `ping()`, `scan(pattern)`, `withPrefix(extra)`, `dedicated()`, `close()` |
| `RedisConnections` | `get(name)`: the named connections of `config('redis.connections')` |
| `RedisCache`, `RedisLock`, `RedisRateLimiter`, `RedisSessionStore` | Drivers (bound by the provider) |
| `encode` / `decode` | JSON keeping `bigint` and `Date` |
| `RedisProvider` | Config: `redis.connections.<name>.{url, prefix, connectTimeout}`, `redis.prefix`, `cache.default`, `cache.prefix`, `cache.stores`, `session.store` |
