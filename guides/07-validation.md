# Validation

`v` is cslug's own validator, with a Zod-like API and no dependency. A **validator** is either a plain schema or a `Validator` class.
`request.validate(X)` returns the parsed, typed data or throws `ValidationError` (422).

## A plain schema (most cases)

```ts
// app/validators/store-trip-request-validator.ts
import { v } from '@cslug/validation'

export const StoreTripRequestValidator = v.object({
  circuitId: v.uuid(),
  startDate: v.date().future(),                          // 'YYYY-MM-DD', must be after today
  nights: v.int().min(3).max(30),
  groupSize: v.int().min(1).max(12),
  budget: v.money({ currencies: ['EUR', 'USD', 'GBP'] }), // { amount: bigint, currency }
  interests: v.array(v.enum(['wildlife', 'hiking', 'beach', 'culture', 'photography'])).max(5).default([]),
  name: v.string().trim().min(2).max(120),
  email: v.email().toLowerCase(),
  whatsapp: v.phone().optional(),                        // E.164, normalised
  nationality: v.country(),                              // ISO 3166-1 alpha-2
  message: v.string().max(2000).optional(),
})

export type StoreTripRequest = v.infer<typeof StoreTripRequestValidator>
```

Also useful: `v.coerce.int()`, `v.coerce.boolean()` (`'1'`, `'on'`, `'true'` → `true`; for checkboxes),
`v.coerce.date()`, and `v.secret()` (a string that is redacted in logs, error messages and `cslug config:show`).

```ts
const data = await request.validate(StoreTripRequestValidator)
//    ^? { circuitId: string; startDate: string; nights: number; budget: Money; … }
```

Where the input comes from:

| Method | Fields |
|---|---|
| `GET`, `HEAD` | query string (strings coerced to numbers, booleans and dates per the schema) |
| others | JSON body, form body, or multipart (files included) |
| `request.validate(V, { from: 'query' })` | explicit |

Unknown keys are **stripped** by default; use `.strict()` on the object to reject them instead.

## A `Validator` class: DI, async checks, messages

Use a class when validation needs the database or another service.

```ts
// app/validators/register-operator-validator.ts
import { inject } from '@cslug/core'
import { v, Validator, type Fail } from '@cslug/validation'
import { OperatorRepository } from '#app/repositories/operator-repository'

@inject(OperatorRepository)
export class RegisterOperatorValidator extends Validator {
  constructor(private operators: OperatorRepository) { super() }

  schema = v.object({
    companyName: v.string().min(2),
    registrationNumber: v.string().regex(/^\d{5}\s?\d{2}\s?\d{4}\s?\d\s?\d{5}$/),   // NIF
    licenceNumber: v.string(),
    email: v.email(),
    phone: v.phone({ defaultCountry: 'MG' }),
    payout: v.object({
      method: v.enum(['mvola', 'orange_money', 'airtel_money', 'bank']),
      account: v.string(),
    }),
  })

  /** Runs after the schema passes. Add errors with `fail`. */
  async after(data: v.infer<this['schema']>, fail: Fail) {
    if (await this.operators.existsBy({ email: data.email })) fail('email', 'validation.unique')
    if (await this.operators.existsBy({ licenceNumber: data.licenceNumber })) fail('licenceNumber', 'operators.licence_taken')
  }
}
```

`request.validate(RegisterOperatorValidator)` returns the same inferred type.

## Error messages and i18n

Messages are translation keys resolved in the request's locale:

```json
// resources/lang/fr.json
{
  "validation": {
    "required": "Ce champ est obligatoire.",
    "unique": "Cette valeur est déjà utilisée.",
    "int.max": "Doit être au plus {max}."
  },
  "operators": { "licence_taken": "Cette licence est déjà enregistrée." }
}
```

Override per field with `{ message: 'key' }`: `v.literal(true, { message: 'bookings.terms_required' })`.

## What the client receives

**HTML form** (no JavaScript): a redirect back with errors and old input in the session. `useRequest().errors` and
`useRequest().old` give the view the messages and the previous values ([guide 08](./08-views-vue-scss.md#without-javascript)). Nothing to wire.

**Island** using `useForm()` from `@cslug/vue`: the JSON below; `form.errors.groupSize` is set automatically.

**JSON API** (`422 application/problem+json`):

```json
{
  "type": "https://cslug.dev/errors/validation",
  "title": "The given data was invalid.",
  "status": 422,
  "code": "validation.failed",
  "errors": { "groupSize": ["Doit être au plus 12."], "budget.currency": ["Devise non prise en charge."] },
  "requestId": "0193b2…"
}
```

## Files

```ts
export const UploadLicenceValidator = v.object({
  document: v.file({ maxSize: '10mb', types: ['application/pdf', 'image/jpeg', 'image/png'] }), // type sniffed from bytes
  expiresOn: v.date().future(),
})
```

## Reuse outside HTTP

The same schemas validate **job payloads**, **webhook bodies**, **CLI arguments**, **AI tool inputs** and
**AI structured outputs**, and export JSON Schema:

```ts
StoreTripRequestValidator.toJSONSchema()      // used by `cslug describe`, OpenAPI export and the AI module
```

Any [Standard Schema](https://standardschema.dev) (Valibot, ArkType…) is accepted by `request.validate()` too,
but `v` is the documented default.
