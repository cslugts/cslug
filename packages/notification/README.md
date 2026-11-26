# @cslug/notification

Notifications over mail, database, WhatsApp, SMS and custom channels: each message built in the recipient's
locale, one job per delivery, delivery records, and a fake for tests. List `NotificationProvider` in
`bootstrap/providers.ts` (after `MailProvider` for the mail channel).

Part of [cslug](https://github.com/cslugts/cslug). Docs: [docs/README.md](docs/README.md), [docs/api.md](docs/api.md),
[guide 14](../../guides/14-mail-and-notifications.md#notifications).
