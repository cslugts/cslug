# @cslug/webhook

List `WebhookProvider` (after `DatabaseProvider`) in `bootstrap/providers.ts`. It registers the
`cslug_webhook_inbox` migration (`cslug migrate` creates the table) and `cslug webhooks:replay`.
The guide is [guide 17](../../../guides/17-storage-and-webhooks.md#webhooks).

## Signatures

```ts
// config/webhooks.ts
export default defineConfig({
  payments: { secret: env.PAYMENTS_WEBHOOK_SECRET, header: 'X-Signature', format: 't={timestamp},v1={signature}', tolerance: '5m' },
  whatsapp: { secret: env.WHATSAPP_APP_SECRET, header: 'X-Hub-Signature-256', format: 'sha256={signature}' },
})

r.post('/webhooks/payments', [PaymentWebhookController, 'handle']).middleware(verifySignature('payments'))
```

`verifySignature(name)` reads the raw body (`request.raw()`, cached, so `request.body()` still works), computes the
HMAC (`algorithm`: `sha256` default, `sha1`, `sha512`; Web Crypto) and compares it in constant time
(`crypto.subtle.verify`). The header is parsed with `format`: `{signature}` (hex, or base64 with
`encoding: 'base64'`) and optionally `{timestamp}` (Unix seconds); with a timestamp, `${timestamp}.${rawBody}` is
signed and the timestamp must be within `tolerance` of `Clock` (default 5 min). A mismatch is a `401` problem
`webhook.bad_signature`. Other schemes: `verifySignature((request, raw) => boolean)`.

In tests, `signWebhook(name, rawBody, { timestamp? })` returns the headers the sender would send:
`t.post(url).headers(await signWebhook('payments', JSON.stringify(event))).json(event)`.

## The inbox

`WebhookInbox` (an `@inject` class) stores each `(source, externalId)` once:

- `receive(source, externalId, payload, then?)`: in a transaction, `insert … on conflict do nothing`; for a new
  event runs `then` (else the source's processor) in that transaction and returns `true`; a replay returns
  `false` and runs nothing, even under concurrent deliveries. Pair it with a durable job:
  `() => ProcessPaymentEventJob.dispatch({ eventId }).durable()`.
- `process(source, fn)`: the processor of a source (register it in a provider's `boot()`); used by `receive`
  without `then` and by `replay`.
- `payload(source, externalId, schema?)`: the stored payload, validated with a `v` schema; `NotFoundError` if absent.
- `replay(source, externalId)`: run the processor again (`cslug webhooks:replay <source> <id>`), recording
  `replayed_at`.
- `prune(olderThan, source?)`: delete old events (a delivery after that is processed again). Schedule it with
  `s.call('webhooks:prune', ({ resolve }) => resolve(WebhookInbox).prune('90d')).daily()`.
