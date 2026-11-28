# Storage & webhooks

## Storage

Disks are configured once and injected as `Storage`. Drivers: `local` (files under a folder), `s3` (any
S3-compatible service: AWS, R2, MinIO, RustFS…, via `Bun.s3`; credentials from `S3_ACCESS_KEY_ID` /
`S3_SECRET_ACCESS_KEY` by default) and `memory` (tests, throwaway data). Without `config/storage.ts` there is one
`local` disk at `storage/app`.

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
| `put(key, data)` / `putFile(dir, file)` | `putFile` generates `dir/<uuidv7>.<ext>` (extension from the sniffed bytes) and returns the key |
| `get(key)` / `text(key)` / `stream(key)` / `stat(key)` / `exists(key)` / `delete(key)` | A missing key is `FileNotFoundError` (404) |
| `signedUrl(key, { expiresIn, download? })` | Private download (`download`: attachment file name) |
| `signedUploadUrl(key, { expiresIn, type, maxSize? })` | Direct browser upload: `{ url, method: 'PUT', headers }` |
| `verifyUpload(key, { maxSize?, types? })` | After a direct upload: size and type from the bytes; a refused file is deleted (422) |
| `disk('local')` | A specific disk (`storage.put` and the others use the default one) |

```ts
await this.storage.put(`exports/${id}.csv`, csv, { type: 'text/csv' })   // a string, bytes or a Blob
const bytes = await this.storage.get(key)
const { size, type } = await this.storage.stat(key)
return new Response(await this.storage.stream(key), { headers: { 'content-type': type } })
await this.storage.disk('s3').put('backups/db.sql.gz', dump)
```

Keys are relative paths; a leading `/`, `..` segments and backslashes are refused (`storage.bad_key`), so a key
can never leave its disk.

Uploaded files never live under `public/`. On S3, signed URLs are presigned by the service; on a local disk the app
serves them itself at `/_storage/:disk` (signature and expiry checked with `APP_KEY`), so development works the same.

### Direct uploads

Large files go from the browser straight to the disk. A presigned S3 PUT cannot limit the size, so the server
checks the file once the browser says it is done:

```ts
async uploadUrl({ params }: HttpContext) {
  const key = `operators/${params.operator}/licence/${Bun.randomUUIDv7()}.pdf`
  return { key, ...(await this.storage.signedUploadUrl(key, { expiresIn: '10m', type: 'application/pdf' })) }
}
// the island: await fetch(url, { method, headers, body: file }), then POST { key } to:
async uploaded({ params, request }: HttpContext) {
  const { key } = await request.validate(v.object({ key: v.string() }))
  // the key comes back from the browser: accept only keys this operator was given
  if (!key.startsWith(`operators/${params.operator}/licence/`)) throw new ForbiddenError()
  await this.storage.verifyUpload(key, { maxSize: '10mb', types: ['application/pdf'] })   // 422 + deleted if not
  // … record the document
}
```

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
Signatures are hex by default (`encoding: 'base64'` otherwise); `algorithm` is `sha256` (default), `sha1` or
`sha512`. A request that fails is a 401 problem `webhook.bad_signature`. `request.raw()` is cached, so the handler
can still call `request.body()`. Webhook routes live in `routes/api.ts` (no session, no CSRF).

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

## Testing

```ts
const t = testApp({ fakes: ['storage'] })   // every disk becomes a memory disk

test('an operator uploads a licence', async () => {
  await t.post(`/operators/${op.id}/documents`).actingAs(owner).form({ kind: 'licence', document: pdfFile, expiresOn })
    .assertRedirect()
  t.storage.assertExists(`operators/${op.id}/licence/`)    // a key ending in / matches any file under it
})

test('a signed payment webhook is processed once', async () => {
  const event = { id: 'evt_1', type: 'hold.succeeded', bookingId, holdId: 'h_1', amount: 66_000 }
  const headers = await signWebhook('payments', JSON.stringify(event))   // what the provider would send
  await t.post('/webhooks/payments').headers(headers).json(event).assertOk()
  await t.post('/webhooks/payments').headers(headers).json(event).assertOk()   // a replay: no effect
  await t.assertDatabaseHas('cslug_webhook_inbox', { source: 'payments', externalId: 'evt_1' })
})
```

`t.storage.assertMissing(key)` and `t.storage.keys()` complete the storage fake.
