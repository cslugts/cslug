# Events

Events decouple "this happened" from "these things react to it". An event is a small typed class; listeners
are `@inject()` classes discovered in `app/listeners/`.

## Defining an event

```ts
// app/events/booking-deposit-paid.ts
import { Event, type Money } from '@cslug/core'

export class BookingDepositPaid extends Event<{ bookingId: string; amount: Money }>('booking.deposit_paid') {}
```

```ts
// app/events/operator-verified.ts
import { Event } from '@cslug/core'

export class OperatorVerified extends Event<{ operatorId: string }>('operator.verified') {}
```

## Emitting

```ts
await BookingDepositPaid.emit({ bookingId, amount })
```

Inside a transaction, **queued** listeners wait for commit; synchronous listeners run immediately (inside the
transaction, so they can roll it back by throwing).

## Listening

```ts
// app/listeners/update-reliability-badge-listener.ts
import { inject, listener } from '@cslug/core'
import { OperatorVerified } from '#app/events/operator-verified'
import { BadgeService } from '#app/services/badge-service'

@inject(BadgeService)
@listener(OperatorVerified, { queued: true })
export class UpdateReliabilityBadgeListener {
  constructor(private badges: BadgeService) {}

  async handle({ operatorId }: OperatorVerified['payload']) {
    await this.badges.recompute(operatorId)
  }
}
```

- `{ queued: true }` runs the listener as a job (with `tries`, `backoff`, `queue` options like a [job](./11-queues-and-jobs.md)).
- One listener may listen to several events: `@listener([ClaimOpened, ClaimEscalated])`.
- `cslug events` lists every event and its listeners.
- `@inject(...)` and `@listener(...)` can be written in either order; both register on the same class.
- Listeners are discovered in `app/listeners/` (subfolders included).

## Closures (for small things)

```ts
// app/providers/app-service-provider.ts → boot()
BookingDepositPaid.on(({ bookingId }) => this.metrics.increment('deposits'))
```

## Framework events

`app.booted`, `app.shutting_down`, `http.request.handled`, `queue.job.failed`, `schedule.run.finished`,
`mail.sent`, `auth.login`, `auth.failed`, `db.query.slow`. Useful for metrics and alerts:

```ts
QueueJobFailed.on(({ job, error }) => this.alerts.staff(`Job ${job.name} failed: ${error.message}`))
```

## Testing

```ts
const app = testApp({ fakes: ['events'] })
await app.resolve(VerificationService).approve(operator.id)
app.events.assertEmitted(OperatorVerified, (e) => e.payload.operatorId === operator.id)
```
