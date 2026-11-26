# Queues & jobs

A job is an `@inject()` class with a typed payload and a `handle` method. Jobs run in a worker process
(`cslug queue:work`), on cslug's own Redis Streams queue (no dependency).

## Defining a job

```ts
// app/jobs/send-checkin-job.ts
import { inject } from '@cslug/core'
import { Job } from '@cslug/queue'
import { Notifier } from '@cslug/notification'
import { BookingRepository } from '#app/repositories/booking-repository'
import { TravellerRepository } from '#app/repositories/traveller-repository'
import { CheckinDueNotification } from '#app/notifications/checkin-due-notification'

type Payload = { bookingId: string; milestone: 'pickup' | 'mid_trip' | 'completion' }

@inject(BookingRepository, TravellerRepository, Notifier)
export class SendCheckinJob extends Job<Payload> {
  static queue = 'notifications'
  static tries = 5
  static backoff = Job.exponential('30s', { max: '30m', jitter: true })
  static timeout = '60s'

  constructor(
    private bookings: BookingRepository,
    private travellers: TravellerRepository,
    private notifier: Notifier,
  ) { super() }

  async handle({ bookingId, milestone }: Payload) {
    const booking = await this.bookings.findOrFail(bookingId)
    if (booking.status === 'cancelled') return                       // nothing to do
    const traveller = await this.travellers.findOrFail(booking.travellerId)
    await this.notifier.send(traveller, new CheckinDueNotification(booking, milestone))
  }

  /** After the last attempt fails. */
  async failed({ bookingId }: Payload, error: Error) {
    await StaffAlert.emit({ kind: 'checkin_failed', bookingId, error: error.message })
  }
}
```

## Dispatching

```ts
await SendCheckinJob.dispatch({ bookingId, milestone: 'pickup' })                 // ASAP
await SendCheckinJob.dispatch({ bookingId, milestone: 'mid_trip' }).delay('3d')
await SendCheckinJob.dispatch({ bookingId, milestone: 'pickup' }).at(pickupTime)
await SendCheckinJob.dispatch(payload).onQueue('urgent').priority(1)
await SendCheckinJob.dispatch(payload).unique(`checkin:${bookingId}:pickup`)        // ignored if one is pending
```

`dispatch()` is typed from `Job<Payload>`. It is sugar for `resolve(Queue).dispatch(SendCheckinJob, payload)`;
inject `Queue` if you prefer. `await` gives the job id, or `null` when a `unique()` key is already held.
Priorities run from 1 (first) to 10 (last), default 5, and are taken in three bands: 1–3, 4–7, 8–10.

Defaults when a job declares nothing: queue `default`, 3 tries, exponential backoff from 5 s (capped at 10 min,
with jitter), timeout 60 s. These statics and `failed()` are not declared on `Job`, so no `override` is needed. A
job whose constructor takes nothing needs no `@inject`. A run past its `timeout` fails and is retried, but the
handler cannot be stopped: it finishes in the background, one more reason for idempotent side effects.

Payloads are JSON (bigint and Date are supported). Pass **IDs, not rows**: the row may change before the job runs.

### Validating payloads

For jobs fed by outside data (webhooks, AI), declare a schema; the payload is checked on dispatch and again on run:

```ts
export class ProcessPaymentEventJob extends Job.schema(v.object({ eventId: v.string() })) { … }
```

## After commit

Inside `db.transaction()`, dispatches are **held** and sent only when the transaction commits. If it rolls back,
they are discarded. This is the default; opt out with `.immediately()` (rarely right).

```ts
await this.db.transaction(async () => {
  await this.bookings.update(id, { status: 'deposit_paid' })
  await SendReceiptJob.dispatch({ bookingId: id })    // sent at COMMIT
})
```

## Durable dispatch

After-commit still has a tiny gap: the process can die between `COMMIT` and the Redis push. For jobs that move
money, add `.durable()`:

```ts
await ReleaseStageJob.dispatch({ bookingId, stage: 1 }).durable()
```

The job is written to the `cslug_queue_outbox` table **in the same transaction** (created by `cslug migrate` when
`@cslug/database` is installed). Right after COMMIT the row is pushed to Redis and deleted; rows a crashed
process left behind are relayed by the workers every second. The job is guaranteed to exist if and only if the
transaction committed (relaying is at least once, like delivery). Outside a transaction, `.durable()` just sends.

## Idempotent handlers

Delivery is **at least once**. A job can run twice (worker crash after the side effect, before acknowledging).
Make side effects idempotent:

```ts
async handle({ bookingId, stage }: Payload) {
  await this.db.idempotent(`release:${bookingId}:${stage}`, () => this.escrow.release(bookingId, stage))
}
```

## Chains and batches

```ts
await Queue.chain([
  VerifyDocumentsJob.with({ operatorId }),
  ComputeBadgeJob.with({ operatorId }),
  NotifyOperatorVerifiedJob.with({ operatorId }),
]).dispatch()

await Queue.batch(travellers.map((t) => CrisisBroadcastJob.with({ travellerId: t.id, notice })))
  .then(ReportBroadcastDoneJob.with({ notice }))
  .allowFailures()
  .dispatch()                                                   // MVP #15: crisis broadcast
```

A chain dispatches the next job when the previous one succeeds, and stops at a job that fails for good. A batch
runs its jobs in parallel and dispatches `then()` once all have finished; a job that failed for good cancels
`then()` unless `allowFailures()`. `Queue.batch(…).dispatch()` resolves to the batch id.

## Running workers

```bash
cslug queue:work                                      # all queues in config, concurrency from config
cslug queue:work --queue=payments --concurrency=1     # serial money work
cslug queue:failed                                    # list failed jobs with error + attempts
cslug queue:retry <id|all>
cslug queue:forget <id>
cslug queue:stats                                     # waiting / active / delayed / failed per queue, oldest age
cslug queue:health --stale=2m --max-wait=10m          # exit 1 if no worker ticked lately or a job waits too long
```

Workers stop gracefully on `SIGTERM`: running jobs finish (up to `queue.shutdownTimeout`), the rest stay queued.
A crashed worker's jobs are reclaimed by another worker once their lease (`queue.lease`, default 30 s) expires
(`XAUTOCLAIM`); a running job renews its lease automatically, so long jobs are never taken over. A takeover
counts as an attempt.

Workers load every module in `app/jobs/` and `app/listeners/` (subfolders included) so they can run any job.
A renamed job class can keep its stored name with `static jobName = 'OldName'`.

## Configuration

```ts
// config/queue.ts
export default defineConfig({
  connection: 'default',             // redis connection name
  queues: {
    default:       { concurrency: 10 },
    notifications: { concurrency: 20, rateLimit: '30/s' },
    payments:      { concurrency: 1 },
  },
  failed: { keep: '30d' },
  shutdownTimeout: '30s',
  lease: '30s',                      // a dead worker's job is taken over after this
  block: '1s',                       // one blocking read; also how soon a due delayed job is noticed
})
```

## Testing

```ts
const app = testApp({ fakes: ['queue'] })
await app.post(`/bookings/${id}/accept`).assertRedirect()
app.queue.assertPushed(SendCheckinJob, (j) => j.payload.milestone === 'pickup' && j.delay === undefined)
await app.queue.drain()            // run everything pushed, including jobs pushed by those jobs
```
