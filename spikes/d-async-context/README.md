# Spike (d): the per-request context on `AsyncLocalStorage` in Bun

**Verdict: ✅ yes.** The context survives every async hop cslug relies on, under heavy concurrency, and costs
about a quarter of a microsecond per request: invisible next to HTTP handling.

Run it: `bun run.ts` (needs `ab`; uses Redis on :6379 db 15 if available). Throwaway code; the real
implementation goes in `@cslug/core` (docs/architecture.md § Ambient context).

## Correctness (16/16 pass; Bun 1.3.14)

2,000 concurrent units of work, each with its own `requestId`, random delays, and every hop below. Each unit
must read **its own** context afterwards.

| Hop | Result |
|---|---|
| `await`, `queueMicrotask`, `setTimeout`, `setImmediate`, `Bun.sleep` | ✅ |
| `Promise.all` children, async generators (`for await`) | ✅ |
| `EventEmitter` listeners (synchronous `emit`) | ✅ |
| `fetch()`, `Bun.file().text()`, `crypto.subtle` | ✅ |
| `Bun.redis` command (native client, a stand-in for `Bun.sql`) | ✅ |
| **Streamed response body**: `ReadableStream.pull` runs *after* the handler returned | ✅ context kept |
| Nested `run()` (ambient transaction): visible inside, restored after a throw | ✅ |
| Outside any `run()`: no context | ✅ |

**Not verified here: `Bun.sql`.** The local Postgres needs credentials. This becomes the first test of
milestone M2 ("context survives `await sql` and `sql.begin()`"), because ambient transactions depend on it.

## Cost

| Micro-benchmark (per operation) | ns |
|---|---|
| async function with 1 `await` (baseline) | 244 |
| `als.run()` + 1 `await` | 266 (**+22 ns**) |
| `als.run()` + 10 `getStore()` + 3 `await`s (a typical request) | 491 (**≈ +250 ns** over a run-free equivalent) |
| `getStore()` | **6.2** |

| HTTP (`Bun.serve`, `ab -k -c 64 -n 100000`, median of 3 runs) | req/s | p99 | vs plain |
|---|---|---|---|
| plain: no context, values passed explicitly | 23,051 | 4–5 ms | — |
| `als`: one `run()` per request, 10 reads across 3 awaits | 22,623 | 4–5 ms | −1.9 % |
| `heavy`: + nested transaction `run()`, 50 more reads across 6 awaits | 22,661 | 5 ms | −1.7 % |

The differences are within run-to-run noise (single runs vary ±3 %). `ab` is single-threaded and probably the
bottleneck at ~23k req/s, so the HTTP numbers show that the overhead is **below noise**, not an exact figure.
The micro-benchmark is the precise number: ≈0.25 µs per request, or 0.6 % of one core at 23k req/s.

## Findings for `@cslug/core`

1. **Keep the design:** one `AsyncLocalStorage<Context>` set by the kernel per request, job and command. Nested
   `run()` for transactions, `withLocale()` and similar overrides.
2. **Reads are cheap enough to call freely** (`t()`, `config()`, the logger, repositories reading `ctx().tx`).
   No caching layer is needed.
3. **Streaming responses and SSE keep the request context**, so logging and `t()` work inside stream callbacks.
4. **Add an M2 test for `Bun.sql`**, and an M6 test for the queue worker (context per job).
