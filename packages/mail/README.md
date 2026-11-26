# @cslug/mail

Mailables rendered from Vue views (CSS inlined, plain-text part derived), a `Mailer` that sends now or queues the
rendered message, and transports: SMTP (own client: STARTTLS, AUTH), Resend, Postmark, Brevo, log, array.
List `MailProvider` in `bootstrap/providers.ts`.

Part of [cslug](https://github.com/cslugts/cslug). Docs: [docs/README.md](docs/README.md), [docs/api.md](docs/api.md),
[guide 14](../../guides/14-mail-and-notifications.md).
