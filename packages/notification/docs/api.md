# @cslug/notification: API

| | |
|---|---|
| `Notification` | `via(to)` → channel names; `to<Channel>(to)` → message; `type`; `messageFor(channel, to)`; `static notificationName` |
| `Notifier` | Injectable. `send(to, notification)`, `sendMany(recipients, notification)`, `extend(name, channel)`, `channel(name)`, `run(delivery)` (what the job calls) |
| `Recipient` | `{ id?, email?, whatsapp?, phone?, locale?, name? }` |
| `recipient(value, fn)` | `value` with explicit routes |
| `routeOf(value)` | The routes of a recipient object |
| `Channel` | `send(to, message, delivery)`; `manual?` |
| `LogChannel`, `ManualChannel` | The `log` and `manual` drivers |
| `Delivery` | `{ id, recipientId?, type, channel, to, message }` (the job payload) |
| `NotificationStore` | `notify`, `record`, `mark`: set by the provider with @cslug/database |
| `NotificationProvider` | Config `notification`: `queued` (true), `queue` (`default`), `whatsapp.driver` / `sms.driver` (`log`, `manual`). Registers the migrations and the job `cslug.notification` when database and queue are installed |
| `NOTIFICATION_MIGRATIONS` | The migration folder (`cslug_notifications`, `cslug_notification_deliveries`) |
| `NotificationFake`, `installNotificationFake(app)` | `fakes: ['notify']`: `assertSentTo`, `assertNotSentTo`, `assertNothingSent`, `sentTo`, `sent` |
