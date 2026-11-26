# @cslug/webhook: API

| | |
|---|---|
| `verifySignature(name \| (request, raw) => boolean)` | Middleware: 401 `webhook.bad_signature` unless signed |
| `checkSignature(name, request)` | The check itself → boolean |
| `signWebhook(name, rawBody, { timestamp? })` | Headers that sign `rawBody` as `name` would (tests) |
| `WebhookSource` | Config `webhooks.<name>`: `secret`, `header`, `algorithm` (`sha256`), `format` (`'{signature}'`), `encoding` (`hex`), `tolerance` (`'5m'`) |
| `WebhookInbox` | `receive(source, externalId, payload, then?)` → `true` (new) / `false` (replay), `process(source, fn)`, `payload(source, externalId, schema?)`, `replay(source, externalId)`, `prune(olderThan, source?)` |
| `WebhookProvider` | Registers the `cslug_webhook_inbox` migration and `WebhooksReplayCommand` (`webhooks:replay <source> <externalId>`) |
| `WEBHOOK_MIGRATIONS` | The migration folder |
