# @cslug/notification

List `NotificationProvider` in `bootstrap/providers.ts` and inject `Notifier`. The guide is
[guide 14](../../../guides/14-mail-and-notifications.md#notifications).

## Notifications

A `Notification` lists its channels per recipient in `via(to)` and builds one message per channel in
`to<Channel>(to)`: `toMail` returns a `Mailable`, `toDatabase`, `toWhatsapp`, `toSms` and custom channels return a
JSON value. `static notificationName` names the type stored with deliveries (default: the class name).

```ts
await notifier.send(traveller, new CheckinDueNotification(booking, 'mid_trip'))
await notifier.sendMany(travellers, new CrisisNotice(notice))
```

## Recipients

Any object. Its routes are read from `id`, `email`, `whatsapp` (else `phone`), `phone`, `locale` and `name`;
`recipient(row, (row) => ({ … }))` sets them explicitly (for example, WhatsApp only with consent).

## Delivery

When `send()` runs, every message is built in the recipient's locale (`withLocale`). Then, per channel:

- `mail`: handed to the Mailer, `mailer.to(email).locale(locale).queue(mailable)`, so it is rendered now and sent
  by the Mailer's job `cslug.mail` (`notification.queued: false` sends it instead).
- `database`: a `cslug_notifications` row (`recipient_id`, `type`, `data`, `read_at`) in the current transaction.
- other channels: one job `cslug.notification` per delivery on `notification.queue` (default `default`), so a
  failure retries that channel only. Inside a transaction the job waits for COMMIT. Without @cslug/queue (or with
  `queued: false`) it runs after COMMIT in the process.

With @cslug/database, every delivery is recorded in `cslug_notification_deliveries` (`channel`, `status`: `queued`,
`sent`, `manual`, `failed` with `error`, and the message); `cslug migrate` creates both tables.

## Channels

- `whatsapp` and `sms`: driver `log` (default, logs `notification.logged`) or `manual` (config
  `notification.whatsapp.driver`): the delivery is recorded with status `manual` for staff to send.
- Custom: implement `Channel` (`send(to, message, delivery)`; `manual = true` to only record) and register it in a
  provider's `boot()`: `this.app.resolve(Notifier).extend('slack', SlackChannel)`. A class is built by the
  container, so it can `@inject` what it needs. `extend` also replaces a built-in channel.

## Tests

`testApp({ fakes: ['notify'] })` → `t.notify`: messages are built for every channel (so `toMail` and the others run)
and recorded, never delivered. `assertSentTo(to, Cls, { channel?, where? })`, `assertNotSentTo(to, Cls)`,
`assertNothingSent()`, `sentTo(to, Cls?, channel?)`, `sent`. A recipient matches by the same object, the same `id`,
else the same email.
