# @cslug/queue

Jobs on cslug's own queue on Redis Streams ([D8](../../../docs/decisions.md)), with no dependency. List
`QueueProvider` after `RedisProvider` in `bootstrap/providers.ts`; the guide is
[guide 11](../../../guides/11-queues-and-jobs.md).

```ts
@inject(BookingRepository)
export class SendCheckinJob extends Job<{ bookingId: string }> {
  static queue = 'notifications'
  static tries = 5
  static backoff = Job.exponential('30s', { max: '30m', jitter: true })
  constructor(private bookings: BookingRepository) { super() }
  async handle({ bookingId }: { bookingId: string }) { … }
  async failed({ bookingId }: { bookingId: string }, error: Error) { … }    // after the last attempt
}

await SendCheckinJob.dispatch({ bookingId }).delay('3d').unique(`checkin:${bookingId}`)
```

The statics (`queue`, `tries`, `backoff`, `timeout`, `jobName`) and `failed` are not declared on `Job`, so
apps with `noImplicitOverride` need no `override`. Defaults: queue `default`, 3 tries, exponential backoff from
5 s (capped at 10 min, with jitter), timeout 60 s. A job without constructor arguments needs no `@inject`.

## How it works

| | Redis (under the connection prefix + `queue:`) |
|---|---|
| Waiting jobs | A stream per queue and priority band: `q:<queue>:high`, `q:<queue>`, `q:<queue>:low` (priorities 1–3, 4–7, 8–10), consumer group `workers` |
| Delayed jobs and retries | A sorted set `delayed:<queue>` scored by due time; workers move due jobs to the streams (Lua) |
| `unique(key)` | `SET unique:<key> <job id> NX PX` (default hold 1 day + delay); released when the job finishes or fails for good |
| Failed jobs | A hash `failed` + a sorted set `failed:index`; older than `queue.failed.keep` (default 30 d) are pruned |
| Ack, retry, fail | One Lua script each (`XACK` + `XDEL` + the next step), so a job is never lost between two commands |

**Dispatch.** Inside `db.transaction()` the push is held until COMMIT and dropped on rollback (core's
`afterCommit`, which `@cslug/database` drives); `.immediately()` opts out. Outside a transaction it is sent
before `await` returns. `await` gives the job id, or `null` when a `unique` key is already held (inside a
transaction the id, since the check happens at COMMIT). Payloads are JSON that keeps `bigint` and `Date`.

**Workers.** `cslug queue:work` loads `app/jobs/` and `app/listeners/` (subfolders included, not `*.test.ts`),
then runs a read loop per queue on its own connection (`autoReconnect: false`, a client-side deadline on each
blocking read; spike c). Each job runs in a fresh scope and context (`jobId`, `attempt`), its payload checked
against `Job.schema(…)` if declared, under `timeout`. A failure retries after `backoff(attempt)`; after `tries`
attempts, `failed(payload, error)` runs once and the job goes to the failed store.

**Crashes.** A running job renews its lease every `lease / 3`. A job whose worker died is taken over by another
worker once it has been idle for `queue.lease` (default 30 s; `XAUTOCLAIM`), and counts as an attempt. Delivery is
**at least once**: make side effects idempotent (`db.idempotent`). A job that runs past its `timeout` fails, but
its handler cannot be stopped and finishes in the background.

**Shutdown.** On `SIGTERM` the provider stops the workers: no new reads, running jobs finish (up to
`queue.shutdownTimeout`, default 30 s); what is left is taken over after its lease.

**Queued listeners.** `@listener(Event, { queued: true, queue, tries })` runs as the job `cslug.listener` on that
queue, after COMMIT.

## Commands

`queue:work [--queues=a,b] [--concurrency=n]` (`--queue` works too; default: every queue in config, concurrency
from config, else 1) · `queue:failed [--json]` · `queue:retry <id|all>` · `queue:forget <id>` ·
`queue:clear [queue] [--force]` · `queue:stats [--json]`.

## Tests

`testApp({ fakes: ['queue'] })` swaps in `QueueFake` (`t.queue`): `assertPushed(Job, (j) => …)`,
`assertNotPushed`, `assertPushedCount`, `assertNothingPushed`, `of(Job)`, `pushed`, and `drain()`, which runs
every recorded job (delays ignored), including those they push. A rolled-back dispatch is never recorded.

## Scheduler

List `ScheduleProvider` after `QueueProvider`. It loads `routes/schedule.ts` at boot
([guide 12](../../../guides/12-scheduler.md)):

```ts
export default defineSchedule((s) => {
  s.job(DispatchDailyCheckinsJob).dailyAt('08:00').timezone('Indian/Antananarivo')
  s.call('cache:prune-fx', async ({ resolve }) => resolve(Cache).tags(['fx']).flush()).hourly()
  s.cron('0 */6 * * *', 'db:vacuum-webhook-inbox', VacuumWebhookInboxJob)
})
```

- **Cron:** cslug's own 5-field parser (lists, ranges, steps, month and day names, 0 or 7 for Sunday; day of month
  OR day of week when both are set). Times are wall-clock in the entry's zone (`.timezone()`, else
  `schedule.timezone`, else UTC), DST included.
- **Once per tick:** before running, an instance takes the lock `schedule:<name>:<tick>` (core's `Lock`, Redis with
  `RedisProvider`) and keeps it 10 min, so any number of schedulers run an entry once per minute.
- **No overlap:** a job entry is dispatched with `unique('schedule:<name>')` (skipped while the last one waits or
  runs); an inline task holds `schedule:<name>:running`. `.allowOverlap()` turns both off.
- **Names:** from the job class (`DispatchDailyCheckinsJob` → `dispatch-daily-checkins`), the first argument of
  `s.call` / `s.cron`, or `.as(name)`. Two entries with one name are refused.
- **History:** the last 100 runs per entry in Redis (`schedule:history:<name>` under the queue prefix): `name`,
  `scheduledFor`, `startedAt`, `finishedAt`, `status` (`dispatched`, `ok`, `failed`, `skipped`), `error`.
- **`catchUp('once')`:** when the loop starts, an entry whose next tick after its last recorded run is already past
  runs once for that tick. Other missed ticks are skipped.
- **The loop** (`schedule:work`) ticks at the start of every minute, writes a heartbeat, and stops after the current
  tick at shutdown.

Commands: `schedule:work`, `schedule:run` (one tick, for an external cron), `schedule:list [--json]`,
`schedule:history <name> [--last=10]`, `schedule:test <name>` (run now, ignoring the schedule and the tick lock).

In tests: `t.schedule.runDue()` runs what is due at `t.clock`'s time, without the tick lock, so a test can replay a
tick.

Not yet (M6c): `.durable()` (outbox), chains and batches, per-queue `rateLimit`, `queue:health`,
`serve --with-worker/--with-scheduler`.
