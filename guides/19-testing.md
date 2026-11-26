# Testing

`bun test`, plus `@cslug/testing`: an app factory, HTTP helpers that don't open a port, database isolation,
fakes for every side effect, and time travel.

## A feature test

```ts
// tests/feature/trip-requests/store.test.ts
import { test, expect } from 'bun:test'
import { testApp } from '@cslug/testing'
import { CircuitFactory } from '#database/factories/circuit-factory'
import { TripRequestReceivedMail } from '#app/mail/trip-request-received-mail'

const app = testApp({ fakes: ['mail', 'queue'] })

test('a traveller can request a trip', async () => {
  const circuit = await CircuitFactory.create()

  await app
    .post('/fr/trip-request')
    .form({
      circuitId: circuit.id, startDate: '2027-05-14', nights: 10, groupSize: 2,
      budget: { amount: '400000', currency: 'EUR' }, name: 'Giulia', email: 'GIULIA@example.it', nationality: 'IT',
    })
    .assertRedirect('/fr/trip-request/thanks')
    .assertSessionHas('success')

  await app.assertDatabaseHas('trip_requests', { email: 'giulia@example.it', groupSize: 2 })
  app.mail.assertQueued(TripRequestReceivedMail, (m) => m.to === 'giulia@example.it' && m.locale === 'fr')
})

test('group size over 12 is rejected', async () => {
  await app.post('/fr/trip-request').form({ groupSize: 20 })
    .assertInvalid({ groupSize: 'Doit être au plus 12.' })     // checks the session errors after redirect-back

  await app.post('/fr/trip-request').json({ groupSize: 20 })     // as an island would
    .assertProblem(422, 'validation.failed')
})
```

## The app

```ts
const app = testApp({
  fakes: ['mail', 'queue', 'notify', 'events', 'storage', 'ai'],   // or 'all'
  config: { 'payments.driver': 'fake' },
  database: 'transaction',                                         // default; see below
})
```

`testApp()` builds the app once per test file and registers `beforeEach` / `afterEach` hooks for isolation.

## HTTP

```ts
await app.get('/bookings').actingAs(traveller).assertOk()
  .assertView(BookingIndex, (props) => expect(props.bookings.data).toHaveLength(2))   // the view and its props
  .assertSee('ALB-7K2Q9F')                                                            // text in the HTML
  .assertIsland('milestone-timeline', { bookingId: id })

await app.post('/api/v1/quotes').withToken(token).json(body).assertCreated().assertJson({ status: 'sent' })
await app.get('/admin').actingAs(traveller).assertForbidden()
await app.delete(`/bookings/${id}`).assertProblem(409, 'booking.invalid_transition')
```

Assertions: `assertOk`, `assertStatus`, `assertCreated`, `assertNoContent`, `assertRedirect(to?)`, `assertForbidden`,
`assertNotFound`, `assertInvalid(errors)`, `assertProblem(status, code)`, `assertJson(subset)`, `assertView(View, fn?)`, `assertSee(text)`, `assertIsland(name, props?)`,
`assertHeader`, `assertCookie`, `assertSessionHas`, `assertOldInput(fields)`, `assertDontSee(text)`.

Other helpers: `app.auth.check()` / `app.auth.user()` (state after the last request), `app.tokens.create(user,
{ abilities })` → `{ plainText }`, `app.db.find(table, id)`, `app.db.count(table, where)`,
`app.mail.assertQueuedCount(Mailable, n)`.

## Database isolation

| Mode | How | Use |
|---|---|---|
| `'transaction'` (default) | Each test runs inside a transaction that is rolled back | Fast; most tests |
| `'truncate'` | Real commits; touched tables truncated after each test | Tests of after-commit dispatch, concurrency, advisory locks |

A test database (`<db>_test`) is migrated once per run. In `'transaction'` mode, `db.transaction()` calls inside the
code under test become savepoints, and after-commit dispatch fires when the **outer** savepoint is released, so
after-commit behaviour is still observable.

## Fakes

```ts
app.queue.assertPushed(SendCheckinJob, (j) => j.payload.bookingId === id)
app.queue.assertNotPushed(ReleaseStageJob)
await app.queue.drain()

app.mail.assertQueued(BookingConfirmedMail)
app.notify.assertSentTo(traveller, CheckinDueNotification, { channel: 'whatsapp' })
app.events.assertEmitted(BookingDepositPaid)
app.storage.assertExists(`operators/${operatorId}/licence/…`)
app.swap(PaymentGateway, new FakePaymentGateway({ failNextRelease: true }))
```

## Time

```ts
app.clock.travelTo('2027-05-15T05:00:00Z')
app.clock.advance('3d')
app.clock.freeze()
```

All framework code (and app code that injects `Clock`) sees the fake time, including job delays and schedules.

## Concurrency tests (from the requirements)

```ts
test('two concurrent releases of the same stage release once', async () => {
  const app = testApp({ database: 'truncate' })
  const booking = await BookingFactory.create({ status: 'deposit_paid' })
  const escrow = () => app.resolve(EscrowService)

  const results = await Promise.allSettled([escrow().release(booking.id, 1), escrow().release(booking.id, 1)])

  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)    // the second is an idempotent no-op
  expect(await app.db.count('ledger_entries', { bookingId: booking.id, kind: 'released' })).toBe(1)
})
```

## Factories

See [guide 09](./09-database.md#seeders-and-factories). In tests: `await OperatorFactory.state('verified').create()`,
`BookingFactory.for(traveller).createMany(3)`.

## Running

```bash
bun test                       # everything
bun test tests/feature/bookings
cslug test --coverage          # wraps bun test; starts the test DB/Redis from docker compose if needed
```
