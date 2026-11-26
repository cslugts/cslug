# @cslug/queue: API

| | |
|---|---|
| `Job<P>` | Base class: `handle(payload)`; optional `failed(payload, error)`. Statics: `dispatch(payload)`, `exponential(base, { max, jitter })`, `schema(schema)` (a base class whose payload is validated on dispatch and before each run) |
| `JobSettings` | Optional statics of a job class: `jobName`, `queue`, `tries`, `backoff`, `timeout`, `payloadSchema` |
| `PendingDispatch` | `delay(duration)`, `at(date)`, `onQueue(name)`, `priority(1…10)`, `unique(key, holdFor = '1d')`, `tries(n)`, `immediately()`; sent when awaited → job id, or `null` for a held unique key |
| `Queue` | Abstract: `dispatch(Job, payload)`, `push(envelope, { runAt, uniqueFor })`. Bound to `RedisQueue` |
| `RedisQueue` | `push`, `promote(queue)`, `ensureGroups(queue)`, `complete` / `retry` / `fail`, `failed()`, `retryFailed(id)`, `forget(id)`, `queues()`, `stats(queue)` → `{ queue, waiting, active, delayed, failed, oldestAgeMs }`, `clear(queue)` |
| `Worker` | `start()`, `stop(timeoutMs)`, `consumer`; options `{ queues: [{ name, concurrency }], leaseMs, blockMs }` |
| `Workers` | The workers of this process: `start(queues)`, `stopAll(timeoutMs)` (called by the provider at shutdown) |
| `QueueFake` | `pushed`, `of(Job)`, `assertPushed(Job, predicate?)`, `assertNotPushed`, `assertPushedCount(Job, n)`, `assertNothingPushed()`, `drain(max = 1000)`. `PushedJob`: `{ id, job, payload, queue, delay?, runAt?, priority?, unique?, tries }` |
| `installQueueFake(app)` | Used by `@cslug/testing` for `fakes: ['queue']` |
| `QueuedListenerJob` | The job (`cslug.listener`) that runs queued `@listener` classes |
| `discoverJobs(app)` | Imports `app/jobs/` and `app/listeners/`, registers job classes; returns how many |
| `registerJob`, `findJob`, `jobName`, `isJobClass`, `settingsOf`, `backoffDelay` | The job registry and settings with defaults |
| `runJob(app, envelope, attempt)`, `runFailedHook` | Run one delivery in a fresh scope and context |
| `JobNotFoundError`, `JobTimeoutError` | Typed errors (`queue.job_not_found`, `queue.job_timeout`) |
| `QueueProvider` | Config `queue.{connection, queues.<name>.concurrency, failed.keep, shutdownTimeout, lease, block}` |
| Commands | `QueueWorkCommand`, `QueueFailedCommand`, `QueueRetryCommand`, `QueueForgetCommand`, `QueueClearCommand`, `QueueStatsCommand` |
