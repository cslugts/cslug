# Events

Events decouple "this happened" from "these things react to it". An event is a small typed class; listeners are
`@inject()` classes in `app/listeners/`, or closures.

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

The name is dot.case and past tense: something that happened. `cslug make:event OperatorVerified` writes the file.
`OperatorVerified['payload']` is the payload type, for listeners.

## Emitting

```ts
await BookingDepositPaid.emit({ bookingId, amount })
```

`emit` runs the listeners in order: closures, then listener classes. **Synchronous** listeners run right away, in
the emitter's context and transaction: one that throws makes `emit` throw, so the transaction can roll back.
**Queued** listeners wait for the transaction to commit and never run if it rolls back.

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

- `{ queued: true }` runs the listener as a job after COMMIT, with the job options `queue`, `tries` and `backoff`
  (guide 11): `@listener(OperatorVerified, { queued: true, queue: 'badges', tries: 5 })`. Without `@cslug/queue`
  installed, it runs in the same process after COMMIT, in a fresh scope, and an error is logged instead of retried.
- Without `queued`, the listener is synchronous: keep it quick, and let it throw to refuse what happened
  (`LoginAttempting` listeners refuse a login this way, guide 15).
- One listener may listen to several events: `@listener([ClaimOpened, ClaimEscalated])`; `handle(payload, event)`
  gets the event instance as its second argument to tell them apart (`event instanceof ClaimOpened`).
- `@inject(...)` and `@listener(...)` can be written in either order; both register on the same class.
- `cslug make:listener UpdateReliabilityBadge` writes the class in `app/listeners/`, where workers load it.

## Closures (for small things)

```ts
// app/providers/app-service-provider.ts → boot()
const off = BookingDepositPaid.on(({ bookingId }) => this.metrics.increment('deposits'))
off()   // stop listening
```

A closure is synchronous, like a listener class without `queued`.

## Framework events

Packages emit events where an app may want to react:

| Event | Package | Payload | Use it to |
|---|---|---|---|
| `LoginAttempting` | auth | `email`, `ip` | refuse a login by throwing (lockout, maintenance) |
| `LoginSucceeded`, `LoginFailed`, `LoggedOut` | auth | `userId`, `ip`; `LoginFailed`: `reason` (`credentials`, `two_factor`, `throttled`), `email` | alert on suspicious logins, record them |
| `TwoFactorEnabled`, `TwoFactorDisabled`, `RecoveryCodesRegenerated` | auth | `userId` | tell the user by email |
| `TokenCreated`, `TokenRevoked` | auth | `userId`, `tokenId`, `name`, `abilities` / `all` | audit API access |
| `AccountLocked` | security | `email`, `userId?`, `ip`, `until` | tell the owner (guide 24) |
| `AiBudgetAlert` | ai | `day`, `spentUsd`, `limitUsd` | warn someone before the AI budget runs out (guide 18) |

Requests, jobs, queries and AI calls are not events: they are traced and measured (guide 23).

## Testing

```ts
const app = testApp({ fakes: ['events'] })
await app.resolve(VerificationService).approve(operator.id)
app.events.assertEmitted(OperatorVerified, (e) => e.payload.operatorId === operator.id)
app.events.assertNotEmitted(OperatorSuspended)
```

The events fake records emitted events instead of running their listeners. To test a listener, call its `handle`
with a payload, or leave the fake out so it runs.
