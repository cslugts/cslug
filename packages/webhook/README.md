# @cslug/webhook

Webhook signature verification (`verifySignature`, HMAC in constant time, timestamp tolerance) and an exactly-once
inbox (`WebhookInbox`): an event delivered ten times has one effect. List `WebhookProvider` in
`bootstrap/providers.ts`.

Part of [cslug](https://github.com/cslugts/cslug). Docs: [docs/README.md](docs/README.md), [docs/api.md](docs/api.md),
[guide 17](../../guides/17-storage-and-webhooks.md).
