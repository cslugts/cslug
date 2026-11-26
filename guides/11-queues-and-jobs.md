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
inject `Queue` if you prefer.

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

The job is written to a `queue_outbox` table **in the same transaction**; the worker relays outbox rows to Redis
and marks them sent. The job is guaranteed to exist if and only if the transaction committed.

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

## Running workers

```bash
cslug queue:work                                      # all queues in config, concurrency from config
cslug queue:work --queue=payments --concurrency=1     # serial money work
cslug queue:failed                                    # list failed jobs with error + attempts
cslug queue:retry <id|all>
cslug queue:forget <id>
cslug queue:stats                                     # waiting / active / delayed / failed per queue, oldest age
```

Workers stop gracefully on `SIGTERM`: running jobs finish (up to `queue.shutdownTimeout`), the rest stay queued.
A crashed worker's jobs are reclaimed by another worker once their lease (`timeout` + grace) expires
(`XAUTOCLAIM`); long jobs extend their lease automatically while running.

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
})
```

## Testing

```ts
const app = testApp({ fakes: ['queue'] })
await app.post(`/bookings/${id}/accept`).assertRedirect()
app.queue.assertPushed(SendCheckinJob, (j) => j.payload.milestone === 'pickup' && j.delay === undefined)
await app.queue.drain()            // run everything pushed, including jobs pushed by those jobs
```
