# Spike (c): the queue on Redis Streams through `Bun.redis`

**Verdict: ✅ yes, with one connection rule.** `Bun.redis` (no dependency) supports everything the queue needs:
streams, consumer groups, blocking reads, `XAUTOCLAIM` lease recovery, Lua scripts, `SET NX` unique keys and
trimming. It is fast enough by a wide margin. One `Bun.redis` behaviour must be designed around: see
[the known issue](#known-issue-a-killed-connection-wedges-the-default-client).

Run it: `bun run.ts [redis-url]` (default `redis://localhost:6379/15`). It uses only `spike-c:*` keys and deletes them.
Throwaway code; the real implementation goes in `@cslug/queue`.

## What was checked (22/22 pass; Bun 1.3.14, Redis 8.0.5)

| Area | Result |
|---|---|
| `XGROUP CREATE … MKSTREAM`, `XADD`, `XREADGROUP`, `XACK`, `XPENDING` through `send()` | ✅ |
| A blocking read (`BLOCK`) on an empty stream returns `null` on timeout | ✅ |
| A blocked reader does **not** slow other clients (max PING 1.1 ms while blocked) | ✅ |
| A blocked reader wakes as soon as a job is added (**0.65 ms**) | ✅ |
| A command on the **same** connection waits behind the blocking read, so **each worker loop needs its own connection** | ✅ (confirmed) |
| **Crash recovery:** a child worker reads a job and is `SIGKILL`ed before acking. The job is not reclaimed before the lease; after it, `XAUTOCLAIM` hands it to another worker with its payload | ✅ |
| Delivery count is tracked (`XPENDING` shows 2 after reclaim), usable for `tries` | ✅ |
| Lua (`SCRIPT LOAD` + `EVALSHA`): atomic promotion of due delayed jobs from a sorted set to the stream | ✅ |
| Unknown script hash raises `NOSCRIPT`, so the driver can reload and retry | ✅ |
| Unique jobs: `SET key NX PX` | ✅ |
| 20,000 jobs enqueued and consumed (4 consumers) | ✅ |
| An idle client whose connection the server kills reconnects automatically | ✅ |
| Worker connection with `autoReconnect: false`: a killed blocking read **rejects at once**, and a fresh connection resumes the group | ✅ |
| `close()` on a blocked connection rejects at once, so `SIGTERM` doesn't wait for the block timeout | ✅ |
| `XADD MAXLEN ~ 1000` keeps the stream bounded | ✅ |

## Numbers (one Bun process, local Redis)

| | |
|---|---|
| Enqueue (auto-pipelined `XADD`) | **≈223,000 jobs/s** (20k in 90 ms) |
| Consume + ack, 4 consumers, `COUNT 100` | **≈77,000 jobs/s** (20k in 260 ms) |
| Enqueue → delivered to a blocked worker | **p50 0.2–0.3 ms, p99 1.4–2.2 ms**, max ≈5 ms |

Albastr's MVP needs a few hundred jobs a day; the overhead of the queue itself is negligible.

## Findings for `@cslug/queue` and `@cslug/redis`

1. **Replies are RESP3.** `Bun.redis` negotiates RESP3, so `XREAD`/`XREADGROUP` return a **map** `{ stream: entries }`,
   not RESP2's `[[stream, entries]]`. The first version of this spike parsed the RESP2 shape, saw zero entries and
   spun forever. The driver parses replies in one place, with tests for both shapes.
2. **One dedicated connection per blocking worker loop**, never shared with other commands.
3. **Worker connections use `autoReconnect: false`, and the worker reconnects itself** with backoff. Pending
   jobs aren't lost meanwhile: they stay in the PEL and are reclaimed by `XAUTOCLAIM` after the lease.
4. **Belt and braces:** every blocking read also gets a client-side deadline (`BLOCK` + a margin). On expiry the
   worker discards the connection and opens a new one.
5. **Lease = job timeout + grace.** Workers run `XAUTOCLAIM` periodically, and long jobs extend their lease by
   re-claiming their own entry (`XCLAIM … JUSTID`) as a heartbeat. The delivery count from `XPENDING` drives `tries`.
6. **Lua for multi-key atomic steps** (promote delayed jobs, dead-letter after the last attempt), loaded with
   `SCRIPT LOAD`, called with `EVALSHA`, reloaded on `NOSCRIPT`.
7. **Minimum Redis version: 6.2** (`XAUTOCLAIM`). Tested on 8.0.5.

## Known issue: a killed connection wedges the default client

With default options (`autoReconnect: true`), if Redis drops a connection **while a blocking read is in flight**,
the read never settles, and every later command on that client also hangs, while `client.connected` still reports
`true`. An idle client whose connection is killed reconnects fine. Reproduced in `run.ts` § 7
(`knownIssueDefaultClient` in the output).

This looks like a `Bun.redis` bug worth reporting upstream with the repro. cslug doesn't depend on a fix:
findings 3 and 4 avoid it.

## Not covered (milestone M6)

Redis restart or failover during a run, Redis Cluster (out of scope for v1), memory use with millions of
entries, the outbox relay from Postgres.
