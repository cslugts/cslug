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
import { testApp } from '@cslug/testing'

const app = testApp({
  fakes: ['mail', 'queue', 'notify', 'events', 'storage', 'ai', 'workflows'],
  config: { 'payments.driver': 'fake' },
  database: 'transaction',                                         // default; see below
})
```

`testApp()` builds the app once per test file and registers `beforeAll` / `beforeEach` / `afterEach` hooks for
isolation, so call it at the top of the file, not inside a test. The app is `createApp()` from `bootstrap/app.ts`
(`create: () => …` builds another), on the database of `.env.test`, which `bun test` loads. Each fake listed is
reset before every test and typed on `app`.

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
`app.assertDatabaseMissing(table, where)`, `app.actingAs(user)` (every request of this test), and
`app.beforeRequest((r) => r.header('accept-language', 'fr'))`.

Building a request: `.header(name, value)`, `.headers({…})`, `.withToken(plainText)`, `.actingAs(user)`,
`.json(data)` (with the session's CSRF token, as an island sends it), `.form(data)` (nested keys, CSRF, Referer).
Cookies carry over between the requests of a test, like a browser. Awaiting a request gives a `TestResponse`
(`status`, `headers`, `body()`, `json()`, `session()`); `.follow()` makes the GET to the redirect location:

```ts
const res = await app.post('/login').form({ email, password }).assertRedirect('/dashboard')
const { id } = await (await app.post('/api/v1/quotes').withToken(token).json(body)).json<{ id: string }>()
await app.post('/register').form(data).follow().assertSee('Welcome')
```

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
app.storage.assertExists(`operators/${operatorId}/licence/`)          // a file under it (generated name)
app.swap(PaymentGateway, new FakePaymentGateway({ failNextRelease: true }))
await app.workflows.runUntilIdle()                                    // workflows (guide 25), sleeps fast-forwarded
await app.workflows.assertStatus(runId, 'completed', { outcome: 'expired' })
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
// tests/feature/escrow-concurrency.test.ts: its own file, with real commits
import { testApp } from '@cslug/testing'

const app = testApp({ database: 'truncate' })

test('two concurrent releases of the same stage release once', async () => {
  const booking = await BookingFactory.create({ status: 'deposit_paid' })
  const escrow = () => app.resolve(EscrowService)

  const results = await Promise.allSettled([escrow().release(booking.id, 1), escrow().release(booking.id, 1)])

  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)    // the second is an idempotent no-op
  expect(await app.db.count('ledger_entries', { bookingId: booking.id, kind: 'released' })).toBe(1)
})
```

## Factories

See [guide 09](./09-database.md#factories-and-seeders). In tests: `await OperatorFactory.state('verified').create()`,
`BookingFactory.for({ travellerId: traveller.id }).createMany(3)`.

## Unit tests

Services are plain classes: build them with `new` and fakes, no app needed.

```ts
import { Money } from '@cslug/core'

test('the deposit is 30 % of the total', () => {
  const pricing = new PricingService(new FakeExchangeRates({ 'EUR:MGA': 4900 }), 8)
  expect(pricing.deposit(Money.of(220_000n, 'EUR')).toDecimal()).toBe('660.00')
})
```

`cslug make:test Pricing` writes a test file to start from.

## Running

```bash
bun test                       # everything (the app's `test` script)
bun test tests/feature/bookings
bun test -t 'concurrent'       # tests whose name matches
bun test --coverage
```

The test database (`DATABASE_URL` in `.env.test`, a separate database such as `my_app_test`) is migrated once per
run. Postgres and Redis must be running (`docker compose up -d`). In CI, start them as services:

```yaml
# .github/workflows/test.yml (the job)
services:
  postgres: { image: postgres:17, env: { POSTGRES_PASSWORD: postgres }, ports: ['5432:5432'] }
  redis: { image: redis:7, ports: ['6379:6379'] }
steps:
  - uses: actions/checkout@v4
  - uses: oven-sh/setup-bun@v2
  - run: bun install --frozen-lockfile
  - run: bun run typecheck && bun test
    env: { DATABASE_URL: postgres://postgres:postgres@localhost:5432/app_test, REDIS_URL: redis://localhost:6379 }
```

## Reference

```ts
import { testApp, TestResponse, PendingRequest, EventFake, registerFake } from '@cslug/testing'
import { test, expect, describe, beforeEach } from 'bun:test'
```

`@cslug/testing` is a dev dependency of every preset. Fakes come from their packages and are named in
`testApp({ fakes })`: `events`, `queue`, `mail`, `notify`, `storage`, `ai`, `workflows`. Generator:
`cslug make:test Claims` → `tests/claims.test.ts`.
