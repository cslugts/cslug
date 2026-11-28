# Mail & notifications

**Mail** sends one email. **Notifications** send one message to a person over the channels that suit them
(mail, WhatsApp, SMS, the database for the admin console). Mail templates are Vue SFCs, like views.

## Setup

```bash
cslug add mail             # bun add @cslug/mail; MailProvider; config/mail.ts
cslug add notification     # bun add @cslug/notification; NotificationProvider; config/notification.ts
cslug migrate              # cslug_notifications and cslug_notification_deliveries (with @cslug/database)
```

The `--full` preset has mail already (and Mailpit in `docker-compose.yml` to read what development sends). Mail
templates are Vue files, so `@cslug/vue` renders them. With `@cslug/queue`, queued mail and notifications are jobs;
list `MailProvider` and `NotificationProvider` after `QueueProvider`. Settings: `config/mail.ts`
([transports](#transports)), `config/notification.ts` ([channels](#channels)). Generators: `cslug make:mail
BookingConfirmed` (the class and its template), `cslug make:notification CheckinDue`. Command: `cslug mail:preview`.

## Mailables

`cslug make:mail BookingConfirmed` writes the class and its Vue template; `cslug make:notification CheckinDue` a
notification.

```ts
// app/mail/booking-confirmed-mail.ts
import { Mailable } from '@cslug/mail'
import { renderStandalone } from '@cslug/vue'
import { t } from '@cslug/core'
import BookingConfirmed from '#resources/mail/booking-confirmed.vue'
import TripPack from '#views/trip-pack/show.vue'
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
import { inject } from '@cslug/core'

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

```ts
await this.mailer
  .to(traveller, 'travel-partner@example.com')        // several recipients
  .cc(operator)
  .bcc('archive@example.com')                          // in the envelope only
  .locale(traveller.locale)                            // build() and the template run in this locale
  .queue(new BookingConfirmedMail(booking, operator))  // queued even if the class is not; .sendNow() never queues
```

In `build()`, besides `subject`, `view` and `attach`:

```ts
import { t } from '@cslug/core'

build() {
  return this
    .subject(t('mail.claim_opened.subject'))
    .from({ address: 'support@example.com', name: 'Support' })   // instead of mail.from
    .replyTo(this.operator)                                       // replies go to the operator
    .header('X-Entity-Ref-ID', this.claim.id)
    .view(ClaimOpened, { claim: this.claim })
    .text(t('mail.claim_opened.text', { ref: this.claim.ref }))   // instead of the text derived from the HTML
    .attach(this.storage.disk().get(this.claim.photoKey), { name: 'photo.jpg', type: 'image/jpeg' })   // a promise is fine
    .tag('claims')                                                // passed to the provider (Resend, Postmark…)
}
```

`.html(string)` replaces the Vue template when the HTML comes from elsewhere.

### Transports

```ts
// config/mail.ts
import { defineConfig } from '@cslug/core'

export default defineConfig({
  from: { address: 'bonjour@example.com', name: 'My app' },
  transport: env.MAIL_TRANSPORT,                         // 'smtp' | 'resend' | 'log'
  transports: {
    smtp: { host: env.SMTP_HOST, port: 587, user: env.SMTP_USER, password: env.SMTP_PASSWORD },   // own SMTP client (STARTTLS, AUTH)
    resend: { apiKey: env.RESEND_API_KEY },                                                       // HTTP API via fetch
    log: {},                                             // writes to the log; dev uses Mailpit via smtp
  },
  queue: 'notifications',                               // the queue of queued mail (default 'default')
  queued: true,                                         // queue every mail unless its class says static queued = false
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
import { recipient } from '@cslug/notification'

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
import { defineConfig, inject } from '@cslug/core'
import { type Channel, Notifier, type Recipient } from '@cslug/notification'

export default defineConfig({ queue: 'notifications', whatsapp: { driver: 'manual' } })

// A custom channel: the message comes from the notification's toSlack(to)
@inject(SlackClient)
export class SlackChannel implements Channel {
  constructor(private slack: SlackClient) {}
  async send(to: Recipient, message: unknown) { … }
}
this.app.resolve(Notifier).extend('slack', SlackChannel)   // in a provider's boot()
```

### Reading database notifications

The `database` channel writes rows to `cslug_notifications` (`recipient_id`, `type`, `data`, `read_at`,
`created_at`); read them with the `sql` tag for an inbox or the admin console:

```ts
import { sql } from '@cslug/database'

const unread = await this.db.many(sql<{ id: string; type: string; data: unknown; createdAt: Date }>`
  select id, type, data, created_at from cslug_notifications
  where recipient_id = ${user.id} and read_at is null order by created_at desc limit 20`)
await this.db.exec(sql`update cslug_notifications set read_at = now() where id = ${id} and recipient_id = ${user.id}`)
```

`cslug_notification_deliveries` holds one row per channel and recipient, with its status: the "manual" ones are
the staff's to-do list.

### Incoming replies

WhatsApp replies (check-in "all good" / "problem") arrive as webhooks; route them like any other
[webhook](./17-storage-and-webhooks.md#webhooks) and emit an event (`CheckinReplied`).

## Testing

```ts
import { testApp } from '@cslug/testing'

const app = testApp({ fakes: ['mail', 'notify'] })
app.mail.assertQueued(BookingConfirmedMail, (m) => m.to === traveller.email)
app.notify.assertSentTo(traveller, CheckinDueNotification, { channel: 'whatsapp' })
```

## Reference

```ts
import { Mailable, Mailer, PendingMail, renderMail, MailFake, type Message } from '@cslug/mail'
import { Notification, Notifier, recipient, type Recipient, type Channel, type Delivery, NotificationFake } from '@cslug/notification'
import { useT, route, formatDate, formatMoney } from '@cslug/vue'          // in mail templates
```

| | |
|---|---|
| `Mailable` | `build()` with `subject`, `view`, `html`, `text`, `attach`, `from`, `replyTo`, `header`, `tag`; statics `queued`, `preview()` |
| `Mailer` | Injectable: `to(...)` → `PendingMail` (`cc`, `bcc`, `locale`, `send`, `queue`, `sendNow`) |
| `Notification` | `via(to)`, `toMail`, `toDatabase`, `toWhatsapp`, `toSms`, `to<Channel>` |
| `Notifier` | Injectable: `send(to, notification)`, `sendMany`, `extend(name, channel)` |
| `recipient(value, fn)` | A recipient with explicit routes |
| `MailFake`, `NotificationFake` | `fakes: ['mail']` → `t.mail`, `fakes: ['notify']` → `t.notify` |
