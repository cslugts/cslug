# Mail & notifications

**Mail** sends one email. **Notifications** send one message to a person over the channels that suit them
(mail, WhatsApp, SMS, the database for the admin console). Mail templates are Vue SFCs, like views.

## Mailables

```ts
// app/mail/booking-confirmed-mail.ts
import { Mailable } from '@cslug/mail'
import { renderStandalone } from '@cslug/vue'
import BookingConfirmed from '#resources/mail/booking-confirmed.vue'
import TripPack from '#views/trip-pack/show.vue'
import { t } from '@cslug/core'
import type { Booking } from '#app/tables/booking-table'
import type { Operator } from '#app/tables/operator-table'

export class BookingConfirmedMail extends Mailable {
  static queued = true                          // sent by the worker (default for all mail in config)

  constructor(private booking: Booking, private operator: Operator) { super() }

  build() {
    return this
      .subject(t('mail.booking_confirmed.subject', { ref: this.booking.ref }))
      .view(BookingConfirmed, { booking: this.booking, operator: this.operator })    // props checked by vue-tsc
      .attach(renderStandalone(TripPack, { booking: this.booking }), { name: `trip-pack-${this.booking.ref}.html` })
      .tag('booking')
  }
}
```

```vue
<!-- resources/mail/booking-confirmed.vue -->
<script setup lang="ts">
import { useT, route, formatDate } from '@cslug/vue'
import MailLayout from './layout.vue'                 // the app's own mail layout
import type { Booking } from '#app/tables/booking-table'
import type { Operator } from '#app/tables/operator-table'

defineProps<{ booking: Booking; operator: Operator }>()
const { t } = useT()          // in the recipient's locale
</script>

<template>
  <MailLayout :preview="t('mail.booking_confirmed.preview')">
    <h1>{{ t('mail.booking_confirmed.title') }}</h1>
    <p>{{ t('mail.booking_confirmed.body', { operator: operator.companyName, date: formatDate(booking.startDate, 'long') }) }}</p>
    <a class="button" :href="route('bookings.show', { booking: booking.id }, { absolute: true })">
      {{ t('mail.booking_confirmed.cta') }}
    </a>
  </MailLayout>
</template>
```

cslug ships no mail components. `resources/mail/layout.vue` (created by `bun create cslug`) is the app's own
layout: a table-based shell with a `<style>` block. When sending, cslug **inlines** the `<style>` rules into
`style` attributes and derives the **plain-text part** from the HTML.
`cslug mail:preview` opens every mailable (with a `static preview()`) in the browser, in each locale.

### Sending

```ts
import { Mailer } from '@cslug/mail'

@inject(Mailer)
export class BookingService {
  constructor(private mailer: Mailer) {}

  async confirm(booking: Booking, traveller: Traveller, operator: Operator) {
    await this.mailer.to(traveller).locale(traveller.locale).send(new BookingConfirmedMail(booking, operator))
  }
}
```

`to()` accepts an address, `{ email, name }`, or any row with `email` (and `name`). Queued mail sent inside a
transaction waits for commit.

### Transports

```ts
// config/mail.ts
export default defineConfig({
  from: { address: 'bonjour@albastr.com', name: 'Albastr' },
  transport: env.MAIL_TRANSPORT,                         // 'smtp' | 'resend' | 'log'
  transports: {
    smtp: { host: env.SMTP_HOST, port: 587, user: env.SMTP_USER, password: env.SMTP_PASSWORD },   // own SMTP client (STARTTLS, AUTH)
    resend: { apiKey: env.RESEND_API_KEY },                                                       // HTTP API via fetch
    log: {},                                             // writes to the log; dev uses Mailpit via smtp
  },
  queue: 'notifications',
})
```

Transports: `smtp` (cslug's own client: STARTTLS when offered, implicit TLS with `secure: true`, AUTH PLAIN or
LOGIN; it refuses to send in clear to anything but localhost unless `allowPlain: true`), `resend`, `postmark`,
`brevo` (HTTP APIs through `fetch`), `log` and `array` (in memory).

**Queued mail is rendered when you send it** (in the recipient's locale, with the data of that moment) and the
rendered message is queued as the job `cslug.mail`; the worker only transports it. Nothing about the mailable
has to be serializable. `sendNow()` skips the queue. Without `@cslug/queue`, queued mail is sent after COMMIT in
the same process.

`cslug mail:preview` lists every mailable that has a `static preview()` returning an example instance:

```ts
static preview() { return new TodoDueMail('Ada', [{ title: 'Pay the deposit', dueOn: '2027-05-14', priority: 'high' }]) }
```

## Notifications

```ts
// app/notifications/checkin-due-notification.ts
import { Notification, type Recipient } from '@cslug/notification'
import { t } from '@cslug/core'

export class CheckinDueNotification extends Notification {
  constructor(private booking: Booking, private milestone: Milestone) { super() }

  /** Channels per recipient. */
  via(to: Recipient) {
    return to.whatsapp ? ['whatsapp', 'database'] : ['mail', 'database']
  }

  toWhatsapp() {
    return {
      template: 'checkin_' + this.milestone,               // pre-approved WhatsApp template
      params: [this.booking.ref],
      buttons: [{ reply: 'ok', label: t('checkin.all_good') }, { reply: 'problem', label: t('checkin.problem') }],
    }
  }

  toMail() {
    return new CheckinMail(this.booking, this.milestone)
  }

  toDatabase() {
    return { bookingId: this.booking.id, milestone: this.milestone }   // shown in the admin console
  }
}
```

```ts
await this.notifier.send(traveller, new CheckinDueNotification(booking, 'mid_trip'))
await this.notifier.sendMany(travellersOnDates, new CrisisNotice(notice))        // MVP #15
```

A **recipient** is any object; cslug reads `id`, `email`, `whatsapp` (or else `phone`), `phone`, `locale` and `name`
from it. Set them explicitly with `recipient(row, fn)`:

```ts
const to = recipient(traveller, (t) => ({ whatsapp: t.whatsappOptIn ? t.phone : undefined }))
await this.notifier.send(to, new CheckinDueNotification(booking, 'mid_trip'))
```

Each message is built when the notification is sent, in the recipient's locale. Notifications are queued by
default; each channel is a separate job (`cslug.notification`; mail goes through the Mailer's own `cslug.mail`), so a
WhatsApp failure retries without re-sending the email. Inside a transaction they wait for COMMIT. Delivery status
(`queued`, `sent`, `manual`, `failed` with the error) is stored in `cslug_notification_deliveries`.

### Channels

| Channel | In core | Notes |
|---|---|---|
| `mail` | ✓ | Uses the Mailer |
| `database` | ✓ | `cslug_notifications` table (written in the current transaction), read in the admin console |
| `whatsapp` | `log` and `manual` drivers | `manual` records the message with status `manual` for staff to send from a template (the MVP's step); a Meta Cloud API channel can replace it (`extend('whatsapp', …)`) |
| `sms` | `log` and `manual` drivers | |
| custom | — | Implement `Channel` and register it in a provider |

```ts
// config/notification.ts
export default defineConfig({ queue: 'notifications', whatsapp: { driver: 'manual' } })

// A custom channel: the message comes from the notification's toSlack(to)
@inject(SlackClient)
export class SlackChannel implements Channel {
  constructor(private slack: SlackClient) {}
  async send(to: Recipient, message: unknown) { … }
}
this.app.resolve(Notifier).extend('slack', SlackChannel)   // in a provider's boot()
```

### Incoming replies

WhatsApp replies (check-in "all good" / "problem") arrive as webhooks; route them like any other
[webhook](./17-storage-and-webhooks.md#webhooks) and emit an event (`CheckinReplied`).

## Testing

```ts
const app = testApp({ fakes: ['mail', 'notify'] })
app.mail.assertQueued(BookingConfirmedMail, (m) => m.to === traveller.email)
app.notify.assertSentTo(traveller, CheckinDueNotification, { channel: 'whatsapp' })
```
