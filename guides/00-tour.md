# A tour: the protected deposit

This guide follows **one** Albastr feature through every layer of cslug. It is the riskiest part of the MVP
(build order step 1: *protected payment*, feature #5), so it is the best test of whether the framework is right.

**The story.** A traveller accepts a proposal → pays a deposit into escrow through the payment partner →
the partner calls our webhook → the booking moves to `deposit_paid`, a ledger row is written, the traveller is
notified, and the pickup check-in is scheduled.

> DI uses standard decorators: `@inject(A, B)` lists the constructor's dependencies and `tsc` checks that the
> list matches ([guide 02](./02-container-and-di.md)).

```
app/tables/booking-table.ts                     app/services/payment-gateway.ts
app/enums/booking-status.ts                     app/services/mangopay-gateway.ts
app/repositories/booking-repository.ts          app/services/escrow-service.ts
app/controllers/booking-controller.ts           app/controllers/payment-webhook-controller.ts
app/validators/accept-proposal-validator.ts     app/providers/payment-service-provider.ts
app/policies/booking-policy.ts                  app/jobs/send-checkin-job.ts
app/notifications/deposit-received-notification.ts
resources/views/bookings/pay.vue                resources/components/deposit-breakdown.vue
routes/web.ts · routes/api.ts                   tests/feature/bookings/deposit.test.ts
```

## 1. The table

```ts
// app/tables/booking-table.ts
import { table, id, uuid, text, date, integer, amount, currency, timestamps, shortCode, type Row } from '@cslug/database'
import { travellers } from '#app/tables/traveller-table'
import { operators } from '#app/tables/operator-table'
import { BookingStatus } from '#app/enums/booking-status'

export const bookings = table('bookings', {
  id: id(),
  ref: shortCode('ALB'),
  travellerId: uuid().references(() => travellers),
  operatorId: uuid().references(() => operators),
  status: text().oneOf(BookingStatus.values).default('requested'),
  startDate: date(),
  groupSize: integer(),
  currency: currency(),            // one currency per booking
  total: amount(),                 // bigint minor units
  deposit: amount(),
  ...timestamps(),
}, { indexes: (t) => [t.index('travellerId'), t.index('status', 'startDate')] })

export type Booking = Row<typeof bookings>
```

`cslug make:migration --from-tables` diffs this against the database and writes a plain SQL migration for review.

## 2. The state machine is plain TypeScript

```ts
// app/enums/booking-status.ts
import { states } from '@cslug/core'

export const BookingStatus = states({
  requested:        ['proposed', 'cancelled'],
  proposed:         ['accepted', 'cancelled'],
  accepted:         ['deposit_paid', 'cancelled'],
  deposit_paid:     ['released_stage_1', 'refunded'],
  released_stage_1: ['released_stage_2', 'refunded'],
  released_stage_2: ['completed'],
  completed:        [],
  cancelled:        [],
  refunded:         [],
})
export type BookingStatus = typeof BookingStatus.type
// BookingStatus.assert('accepted', 'completed') → throws ConflictError('booking.invalid_transition')
```

## 3. The payment partner is an abstract class, bound in a provider

```ts
// app/services/payment-gateway.ts
import type { Money } from '@cslug/core'

export abstract class PaymentGateway {
  abstract createHold(input: { bookingId: string; amount: Money; returnUrl: string }): Promise<{ checkoutUrl: string; holdId: string }>
  abstract release(holdId: string, amount: Money, payee: { operatorId: string }): Promise<{ transferId: string }>
  abstract refund(holdId: string, amount: Money): Promise<void>
}
```

```ts
// app/providers/payment-service-provider.ts
import { ServiceProvider, config } from '@cslug/core'
import { PaymentGateway } from '#app/services/payment-gateway'
import { MangopayGateway } from '#app/services/mangopay-gateway'      // fetch-based client, written in the app
import { FakePaymentGateway } from '#app/services/fake-gateway'

export class PaymentServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(PaymentGateway, config('payments.driver') === 'fake' ? FakePaymentGateway : MangopayGateway)
  }
}
```

## 4. The repository and the service

```ts
// app/repositories/booking-repository.ts
import { inject } from '@cslug/core'
import { Repository, gte } from '@cslug/database'
import { bookings } from '#app/tables/booking-table'

@inject()
export class BookingRepository extends Repository(bookings) {
  upcomingFor(travellerId: string, today: string) {
    return this.where({ travellerId, startDate: gte(today) }).orderBy('startDate').all()
  }
}
```

```ts
// app/services/escrow-service.ts
import { inject, Clock, Money } from '@cslug/core'
import { Database } from '@cslug/database'
import { Notifier } from '@cslug/notification'
import { BookingRepository } from '#app/repositories/booking-repository'
import { TravellerRepository } from '#app/repositories/traveller-repository'
import { LedgerRepository } from '#app/repositories/ledger-repository'
import { BookingStatus } from '#app/enums/booking-status'
import { SendCheckinJob } from '#app/jobs/send-checkin-job'
import { DepositReceivedNotification } from '#app/notifications/deposit-received-notification'

@inject(Database, BookingRepository, TravellerRepository, LedgerRepository, Notifier, Clock)
export class EscrowService {
  constructor(
    private db: Database,
    private bookings: BookingRepository,
    private travellers: TravellerRepository,
    private ledger: LedgerRepository,
    private notifier: Notifier,
    private clock: Clock,
  ) {}

  /** Called from the webhook job. Safe to call many times for the same hold. */
  async confirmDeposit(bookingId: string, holdId: string, amount: Money) {
    await this.db.transaction(async () => {
      const booking = await this.bookings.lockForUpdate(bookingId)        // SELECT … FOR UPDATE
      if (booking.status === 'deposit_paid') return                        // already done: idempotent

      BookingStatus.assert(booking.status, 'deposit_paid')
      await this.bookings.update(booking.id, { status: 'deposit_paid' })
      await this.ledger.record({ bookingId, kind: 'deposit_held', amount, reference: holdId })

      // Both are held until COMMIT and dropped if the transaction rolls back.
      const traveller = await this.travellers.findOrFail(booking.travellerId)
      await this.notifier.send(traveller, new DepositReceivedNotification(booking))
      await SendCheckinJob
        .dispatch({ bookingId, milestone: 'pickup' })
        .at(this.clock.atLocal(booking.startDate, '07:00', 'Indian/Antananarivo'))
    })
  }
}
```

## 5. The traveller-facing controller, view and island

```ts
// app/validators/accept-proposal-validator.ts
import { v } from '@cslug/validation'

export const AcceptProposalValidator = v.object({
  acceptTerms: v.literal(true, { message: 'bookings.terms_required' }),
})
```

```ts
// app/controllers/booking-controller.ts
import { inject, Money } from '@cslug/core'
import { type HttpContext, redirect, route } from '@cslug/http'
import { view } from '@cslug/vue'
import PayBooking from '#views/bookings/pay.vue'
import { BookingRepository } from '#app/repositories/booking-repository'
import { BookingPolicy } from '#app/policies/booking-policy'
import { AcceptProposalValidator } from '#app/validators/accept-proposal-validator'
import { PaymentGateway } from '#app/services/payment-gateway'

@inject(BookingRepository, PaymentGateway)
export class BookingController {
  constructor(private bookings: BookingRepository, private gateway: PaymentGateway) {}

  async pay({ params, auth }: HttpContext) {
    const booking = await this.bookings.findOrFail(params.booking)
    await auth.authorize(BookingPolicy, 'pay', booking)
    return view(PayBooking, { booking })
  }

  async accept({ params, request, auth }: HttpContext) {
    const booking = await this.bookings.findOrFail(params.booking)
    await auth.authorize(BookingPolicy, 'pay', booking)
    await request.validate(AcceptProposalValidator)     // on failure: redirect back with errors + old input

    const { checkoutUrl } = await this.gateway.createHold({
      bookingId: booking.id,
      amount: Money.of(booking.deposit, booking.currency),
      returnUrl: route('bookings.show', { booking: booking.id }, { absolute: true }),
    })
    return redirect().away(checkoutUrl)
  }
}
```

The page is a Vue view rendered on the server. It works without JavaScript, and one component is hydrated as an
island for the interactive breakdown:

```vue
<!-- resources/views/bookings/pay.vue -->
<script setup lang="ts">
import { useT, useRequest, route, formatMoney, serialize } from '@cslug/vue'
import Layout from '../layouts/default.vue'
import DepositBreakdown from '#components/deposit-breakdown.vue'
import type { Booking } from '#app/tables/booking-table'

defineProps<{ booking: Booking }>()
const { t } = useT()
const { csrfToken, errors } = useRequest()
</script>

<template>
  <Layout :title="t('bookings.pay.title', { ref: booking.ref })">
    <section class="pay">
      <h1>{{ t('bookings.pay.title', { ref: booking.ref }) }}</h1>
      <p>{{ t('bookings.pay.deposit') }} <strong>{{ formatMoney(booking.deposit, booking.currency) }}</strong></p>

      <!-- an island: server-rendered, then hydrated when it scrolls into view -->
      <DepositBreakdown v-bind="serialize({ total: booking.total, deposit: booking.deposit, currency: booking.currency })"
        hydrate="visible" />

      <form :action="route('bookings.accept', { booking: booking.id })" method="post">
        <input type="hidden" name="_token" :value="csrfToken" />
        <label><input type="checkbox" name="acceptTerms" value="1" /> {{ t('bookings.pay.terms') }}</label>
        <p v-if="errors.acceptTerms" class="error">{{ errors.acceptTerms }}</p>
        <button>{{ t('bookings.pay.cta') }}</button>
      </form>
    </section>
  </Layout>
</template>
```

```vue
<!-- resources/components/deposit-breakdown.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useT, formatMoney, type Serialized } from '@cslug/vue'
import type { Booking } from '#app/tables/booking-table'

// Serialized<>: bigints arrive as strings, because island props cross the network as JSON
const props = defineProps<Serialized<Pick<Booking, 'total' | 'deposit' | 'currency'>>>()
const { t } = useT()
const showStages = ref(false)
const stages = computed(() => [30, 40, 30].map((pct) => (BigInt(props.total) * BigInt(pct)) / 100n))
</script>

<template>
  <div class="breakdown">
    <button type="button" @click="showStages = !showStages">{{ t('bookings.pay.how_released') }}</button>
    <ol v-if="showStages">
      <li v-for="(amount, i) in stages" :key="i">
        {{ t(`bookings.stage.${i + 1}`) }} — {{ formatMoney(amount, currency) }}
      </li>
    </ol>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/tokens' as *;
.breakdown { border: 1px solid $border; padding: $space-3; border-radius: $radius; }
</style>
```

## 6. The webhook: verified, idempotent, queued

```ts
// routes/api.ts
import { defineRoutes } from '@cslug/http'
import { verifySignature } from '@cslug/webhook'
import { PaymentWebhookController } from '#app/controllers/payment-webhook-controller'

export default defineRoutes((r) => {
  r.post('/webhooks/payments', [PaymentWebhookController, 'handle'])
    .middleware(verifySignature('payments'))       // HMAC on raw bytes, timestamp tolerance, constant-time compare
    .name('webhooks.payments')
})
```

```ts
// app/controllers/payment-webhook-controller.ts
import { inject } from '@cslug/core'
import type { HttpContext } from '@cslug/http'
import { WebhookInbox } from '@cslug/webhook'
import { PaymentEventValidator } from '#app/validators/payment-event-validator'
import { ProcessPaymentEventJob } from '#app/jobs/process-payment-event-job'

@inject(WebhookInbox)
export class PaymentWebhookController {
  constructor(private inbox: WebhookInbox) {}

  async handle({ request }: HttpContext) {
    const event = await request.validate(PaymentEventValidator)
    // Stored once (unique on source + event id); replays return early. The job is written to the
    // outbox in the same transaction (.durable()), so it exists if and only if the event was stored.
    await this.inbox.receive('payments', event.id, event, () =>
      ProcessPaymentEventJob.dispatch({ eventId: event.id }).durable(),
    )
    return { received: true }
  }
}
```

## 7. The tests

```ts
// tests/feature/bookings/deposit.test.ts
import { test, expect } from 'bun:test'
import { Money } from '@cslug/core'
import { testApp, signWebhook } from '@cslug/testing'
import { BookingFactory } from '#database/factories/booking-factory'
import { SendCheckinJob } from '#app/jobs/send-checkin-job'
import { DepositReceivedNotification } from '#app/notifications/deposit-received-notification'
import { EscrowService } from '#app/services/escrow-service'
import { TravellerRepository } from '#app/repositories/traveller-repository'

const app = testApp({ fakes: ['queue', 'notify'] })

test('replaying the deposit webhook 10 times writes one ledger entry', async () => {
  const booking = await BookingFactory.create({ status: 'accepted' })
  const payload = { id: 'evt_1', type: 'hold.succeeded', bookingId: booking.id, holdId: 'hold_1', amount: '66000', currency: 'EUR' }

  for (let i = 0; i < 10; i++) {
    await app.post('/webhooks/payments').json(payload).headers(signWebhook('payments', payload)).assertOk()
  }
  await app.queue.drain()

  expect(await app.db.count('ledger_entries', { bookingId: booking.id })).toBe(1)
  await app.assertDatabaseHas('bookings', { id: booking.id, status: 'deposit_paid' })
  app.notify.assertSentTo({ id: booking.travellerId }, DepositReceivedNotification)
  app.queue.assertPushed(SendCheckinJob, (job) => job.payload.milestone === 'pickup')
})

test('a transition that rolls back dispatches nothing', async () => {
  const booking = await BookingFactory.create({ status: 'completed' })
  await expect(app.resolve(EscrowService).confirmDeposit(booking.id, 'hold_1', Money.of(66000n, 'EUR')))
    .rejects.toThrow('booking.invalid_transition')
  app.queue.assertNothingPushed()
})

test('the pay page works without JavaScript and shows the terms error', async () => {
  const booking = await BookingFactory.create({ status: 'proposed' })
  const traveller = await app.resolve(TravellerRepository).findOrFail(booking.travellerId)   // rows are plain objects

  await app.post(`/bookings/${booking.id}/accept`).actingAs(traveller).form({})
    .assertRedirect(`/bookings/${booking.id}/pay`)
    .follow()
    .assertSee('Vous devez accepter les conditions')
    .assertIsland('deposit-breakdown', { currency: 'EUR' })
})
```

## What this tour should tell you

- **Where the money logic lives:** in one service method, one transaction, one row lock.
- **What the framework did for you:** DI, typed validation, after-commit dispatch, webhook dedupe and signature
  checks, a durable outbox, redirect-back-with-errors, i18n, a Vue component hydrated as an island, fakes.
- **What it did *not* hide:** the lock, the state transition, the gateway call.
- **What it depends on:** Bun, plus `vue` and `sass` for the island. Nothing else.

If any line above feels like ceremony, that is exactly the feedback this guide is for.
