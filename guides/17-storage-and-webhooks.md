# Storage & webhooks

## Storage

Disks are configured once and injected as `Storage`. Drivers: `local` and `s3` (any S3-compatible service,
via `Bun.s3`).

```ts
// config/storage.ts
export default defineConfig({
  default: env.APP_ENV === 'production' ? 's3' : 'local',
  disks: {
    local: { driver: 'local', root: 'storage/app' },
    s3: { driver: 's3', bucket: env.S3_BUCKET, endpoint: env.S3_ENDPOINT, region: 'eu-west-3' },
  },
})
```

### Operator documents (MVP #11)

```ts
// app/controllers/operator-document-controller.ts
@inject(Storage, OperatorRepository, OperatorDocumentRepository)
export class OperatorDocumentController {
  constructor(
    private storage: Storage,
    private operators: OperatorRepository,
    private documents: OperatorDocumentRepository,
  ) {}

  async store({ params, request, auth }: HttpContext) {
    const operator = await this.operators.findOrFail(params.operator)
    await auth.authorize(OperatorPolicy, 'uploadDocuments', operator)
    const { document, kind, expiresOn } = await request.validate(UploadDocumentValidator)

    // Server-generated key, never the client's filename; type checked from the bytes by the validator.
    const key = await this.storage.putFile(`operators/${operator.id}/${kind}`, document)

    await this.documents.create({ operatorId: operator.id, kind, key, expiresOn, status: 'submitted' })
    return redirect().back().with('success', t('operators.document_uploaded'))
  }

  async show({ params, auth }: HttpContext) {
    const doc = await this.documents.findOrFail(params.document)
    await auth.authorize(OperatorPolicy, 'viewDocuments', doc)
    return redirect().away(await this.storage.signedUrl(doc.key, { expiresIn: '5m' }))
  }
}
```

| Method | |
|---|---|
| `put(key, data)` / `putFile(dir, file)` | `putFile` generates `dir/<uuidv7>.<ext>` and returns the key |
| `get(key)` / `stream(key)` / `exists(key)` / `delete(key)` | |
| `signedUrl(key, { expiresIn })` | Private download |
| `signedUploadUrl(key, { expiresIn, maxSize, type })` | Direct browser → S3 upload |
| `disk('local')` | A specific disk |

Uploaded files never live under `public/`.

## Webhooks

The escrow partner, WhatsApp and SMS providers call us. cslug gives three building blocks.

### 1. Signature verification

```ts
// config/webhooks.ts
export default defineConfig({
  payments: {
    secret: env.PAYMENTS_WEBHOOK_SECRET,
    header: 'X-Signature',
    algorithm: 'sha256',
    format: 't={timestamp},v1={signature}',      // signs `${timestamp}.${rawBody}`
    tolerance: '5m',                              // rejects replays of old requests
  },
  whatsapp: { secret: env.WHATSAPP_APP_SECRET, header: 'X-Hub-Signature-256', algorithm: 'sha256', format: 'sha256={signature}' },
})
```

```ts
r.post('/webhooks/payments', [PaymentWebhookController, 'handle']).middleware(verifySignature('payments'))
```

The middleware reads the **raw bytes** before any parsing, compares in constant time and returns `401` on mismatch.
Providers with their own scheme can pass a function: `verifySignature((req, raw) => mySdk.verify(raw, req.headers))`.
Signatures are hex by default (`encoding: 'base64'` otherwise). In tests, `signWebhook('payments', rawBody)`
returns the headers the provider would send.

### 2. The inbox (exactly-once processing)

```ts
await this.inbox.receive('payments', event.id, event, () => ProcessPaymentEventJob.dispatch({ eventId: event.id }).durable())
```

`WebhookInbox.receive(source, externalId, payload, then)` (list `WebhookProvider` to get the table):

1. inserts into `cslug_webhook_inbox` (unique on `source, external_id`), storing the payload;
2. if the row already existed, returns `false` without calling `then`: **replays are no-ops**, even when the
   same event arrives several times at once;
3. otherwise runs `then` in the same transaction (so the durable job and the inbox row commit together) and
   returns `true`.

Respond `200` fast; do the work in the job.

### 3. Processing

```ts
@inject(WebhookInbox, EscrowService)
export class ProcessPaymentEventJob extends Job.schema(v.object({ eventId: v.string() })) {
  static queue = 'payments'
  constructor(private inbox: WebhookInbox, private escrow: EscrowService) { super() }

  async handle({ eventId }) {
    const event = await this.inbox.payload('payments', eventId, PaymentEventValidator)
    switch (event.type) {
      case 'hold.succeeded':     return this.escrow.confirmDeposit(event.bookingId, event.holdId, event.amount)
      case 'transfer.succeeded': return this.escrow.markReleased(event.transferId)
      case 'refund.succeeded':   return this.escrow.markRefunded(event.holdId)
    }
  }
}
```

`cslug webhooks:replay payments <eventId>` re-runs processing for one stored event; useful after a bug fix. The
replay needs to know what processing is, so register it once per source (a provider's `boot()`), and `receive`
can then omit `then`:

```ts
inbox.process('payments', (eventId) => ProcessPaymentEventJob.dispatch({ eventId }).durable())
```

Old events can be pruned: `inbox.prune('90d')` (schedule it daily).
