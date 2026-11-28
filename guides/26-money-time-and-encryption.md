# 26. Money, time and encryption

Three things every app gets wrong at least once: amounts in floating point, dates in the server's time zone, and
secrets that cannot be rotated. `@cslug/core` has a small, strict tool for each.

## Money

`Money` is an amount in **integer minor units** (`bigint`: cents, ariary) and an ISO 4217 currency. There is no
floating point anywhere, and amounts in different currencies never mix by accident.

```ts
import { Money } from '@cslug/core'

const price = Money.of(220_000n, 'EUR')          // 2 200,00 € (minor units: cents)
Money.of('220000', 'EUR'); Money.of(220000, 'EUR') // a digit string or a safe integer work too
Money.from({ amount: '220000', currency: 'EUR' })  // from JSON or a row
Money.zero('MGA')
Money.sum([deposit, balance])                      // same currency; Money.sum([], 'EUR') for an empty list

price.add(Money.of(5_000n, 'EUR'))
price.subtract(deposit)
price.add(Money.of(1n, 'USD'))                     // ✗ throws money.currency_mismatch

price.percent(30)                                  // 30 %: 660,00 €
price.multiply('1.055')                            // decimal factors as strings stay exact
price.multiply(3)
// rounding is half away from zero, to the currency's minor unit

price.allocate([30, 40, 30])                       // [660,00 €, 880,00 €, 660,00 €]: never loses a cent;
Money.of(100n, 'EUR').allocate([1, 1, 1])          // [0,34 €, 0,33 €, 0,33 €]: the remainder goes to the first shares

price.isZero(); price.isPositive(); price.isNegative(); price.negate()
price.equals(other); price.compare(other)          // -1, 0, 1 (same currency)

price.toDecimal()                                  // '2200.00' (EUR has 2 digits, JPY 0, KWD 3)
price.format('fr')                                 // '2 200,00 €'
price.format('en')                                 // '€2,200.00'
price.toJSON()                                     // { amount: '220000', currency: 'EUR' }
minorDigits('JPY')                                 // 0
```

Where money lives elsewhere:

| | |
|---|---|
| Tables | `amount()` (a `bigint` column) and `currency()` (`char(3)`): `total: amount(), currency: currency()` (guide 09) |
| Validation | `v.money({ currencies: ['EUR', 'USD'], min: 1 })` → `{ amount: bigint, currency }`; `v.amount()` for a bare amount (guide 07) |
| JSON | `Money` serialises to `{ amount: '220000', currency: 'EUR' }`: JSON has no bigint, so the amount is a string |
| Views | `formatMoney(amount, currency, locale?)` in templates (guide 08, 16) |
| Splitting a payment | `allocate()`: deposits, stages, commissions; the parts always add up to the whole |

## Time: `Clock`

Inject `Clock` instead of calling `new Date()`: it knows the app's time zone, and tests can stop or move it.

```ts
import { Clock, inject } from '@cslug/core'

@inject(Clock)
export class CheckinPlanner {
  constructor(private clock: Clock) {}

  plan(booking: Booking) {
    this.clock.now()                                   // a Date (an instant)
    this.clock.today()                                 // '2027-05-14' in app.timezone
    this.clock.today(1)                                // tomorrow, in app.timezone
    this.clock.today(0, 'Indian/Antananarivo')         // today somewhere else
    this.clock.add('3d'); this.clock.subtract('90d')   // instants relative to now
    // 07:00 local time in Madagascar on the start date, as an instant (DST-safe)
    return this.clock.atLocal(booking.startDate, '07:00', 'Indian/Antananarivo')
  }
}
```

- **Two kinds of values.** A *calendar date* is a `'YYYY-MM-DD'` string (`date()` columns, `v.date()`): a
  birthday, a trip start. An *instant* is a `Date` (`timestamp()` columns, `v.datetime()`): when something happened.
  Converting between them always names a time zone, which is how off-by-one-day bugs are avoided.
- **`app.timezone`** (default `UTC`) is the zone of `clock.today()`, of `v.date().future()` and `.past()` and of
  `formatDate()` (guide 16). Scheduled entries use `schedule.timezone` or their own `.timezone()` (guide 12).
- **Durations** are strings everywhere in cslug: `'500ms'`, `'30s'`, `'10m'`, `'1h30m'`, `'2d'`, `'1w'`, or
  milliseconds. `parseDuration('1h30m')` → `5400000`; anything it does not understand throws (never a silent 0).

In tests, `testApp()` swaps in a `FakeClock` (`t.clock`), frozen at the test's start:

```ts
t.clock.travelTo('2027-05-14T05:00:00Z')
t.clock.advance('3d')                    // reminders due, links expired, sleeps over (guide 19)
```

## Encryption and signatures: `Encrypter`

`APP_KEY` (32 random bytes: `cslug key:generate` prints one, `--write` puts it in `.env`) encrypts and signs. The
framework uses it for encrypted columns, signed URLs, magic links and two-factor secrets; your code can too:

```ts
import { Encrypter, inject } from '@cslug/core'

@inject(Encrypter)
export class PayoutAccounts {
  constructor(private encrypter: Encrypter) {}

  seal(iban: string) {
    return this.encrypter.encrypt(iban)            // 'v1.<iv>.<tag>.<data>': AES-256-GCM, a new IV each time
  }
  open(stored: string) {
    return this.encrypter.decrypt(stored)          // throws crypto.decrypt_failed if tampered or the key is unknown
  }
  receiptToken(payoutId: string) {
    return this.encrypter.sign(payoutId)           // HMAC-SHA256, base64url
  }
  checkReceipt(payoutId: string, token: string) {
    return this.encrypter.verify(payoutId, token)  // constant time
  }
}
```

Most of the time you do not call it: a column is encrypted by declaring it so (`text().encrypted()`, guide 09), and
URLs are signed by `route(…, { signed: true })` (guide 05). Helpers: `Encrypter.random(bytes)` (a random token),
`safeEqual(a, b)` (constant-time comparison), `hmac(key, data)`.

### Rotating `APP_KEY`

A leaked or old key can be replaced without losing data or breaking links in flight. Values made with a key listed
in `APP_PREVIOUS_KEYS` (comma-separated) still decrypt and verify; new ones use `APP_KEY`.

```bash
cslug key:rotate            # prints the new APP_KEY and APP_PREVIOUS_KEYS and the steps
cslug key:rotate --write    # writes them to .env: the new key, the old one first in APP_PREVIOUS_KEYS
# deploy with both variables set, then:
cslug db:reencrypt          # re-encrypts every encrypted column with the new key (in batches of 500)
```

Once the links signed with the old key have expired (magic links: minutes; signed downloads: what you chose),
remove it from `APP_PREVIOUS_KEYS`. `encrypter.needsReencrypt(value)` tells whether a value still uses an old key.

## After the transaction: `afterCommit`

Work that must only happen if the data is saved (send the email, call the partner, dispatch the job) waits for the
transaction to commit:

```ts
import { afterCommit } from '@cslug/core'

await db.transaction(async () => {
  const booking = await bookings.create(input)
  afterCommit(() => analytics.track('booking.created', { id: booking.id }))   // never runs on rollback
})
```

Jobs, queued listeners, mail and notifications already do this on their own (guides 11, 13, 14); `afterCommit` is
for your own side effects. Outside a transaction it runs right after the current task.

## States

A status with rules (`requested → proposed → accepted`, never back) is a `states()` machine in core, and
`repo.transition()` moves a row through it under a lock: guide 09 § State transitions and the tour (guide 00).
