# Validation

`v` is cslug's own validator, with a Zod-like API and no dependency. A **validator** is either a plain schema or a
`Validator` class. `request.validate(X)` returns the parsed, typed data or throws `ValidationError` (422). The same
schemas check job payloads, webhook bodies, env vars, CLI arguments and AI tool inputs.

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

```ts
const data = await request.validate(StoreTripRequestValidator)
//    ^? { circuitId: string; startDate: string; nights: number; budget: { amount: bigint; currency: 'EUR' | … }; … }
```

Schemas are **immutable**: every method returns a new schema, so a base schema can be shared and refined.

## Every builder

| Builder | Output | Notes |
|---|---|---|
| `v.string()` | `string` | `.min(n)`, `.max(n)`, `.length(n)`, `.nonempty()`, `.regex(re)`, `.trim()`, `.toLowerCase()`, `.toUpperCase()` |
| `v.email()` | `string` | Trimmed and checked (also `v.string().email()`) |
| `v.url()` | `string` | Any absolute URL except `javascript:`, `data:`, `vbscript:`, `file:`, `blob:`; `.protocols('https:')` narrows it |
| `v.uuid()` / `v.uuid7()` | `string` | `uuid7` checks the version (the ids cslug generates) |
| `v.secret()` | `string` | Redacted by the logger and `cslug config:show`, `writeOnly` in JSON Schema |
| `v.number()` / `v.int()` | `number` | Finite; `int` is a safe integer. `.min`, `.max`, `.positive()`, `.nonnegative()` |
| `v.bigint()` / `v.amount()` | `bigint` | From a bigint, a safe integer or a digit string (`"220000"`: JSON has no bigint). `.min`, `.max`, `.nonnegative()` |
| `v.boolean()` | `boolean` | |
| `v.date()` | `string` | A calendar date `'YYYY-MM-DD'` (Feb 30 is rejected). `.future()`, `.past()`, `.min('2027-01-01')`, `.max(…)` |
| `v.datetime()` | `Date` | An instant, from a `Date` or an ISO 8601 string |
| `v.enum(['a', 'b'])` | `'a' \| 'b'` | Takes a readonly tuple too: `v.enum(BookingStatus.values)` |
| `v.literal(x, { message? })` | `x` | Exactly `x`: `v.literal(true)` for a "terms accepted" checkbox |
| `v.object(shape)` | inferred | Unknown keys are **stripped** (below) |
| `v.array(schema)` | `T[]` | `.min(n)`, `.max(n)`, `.nonempty()` |
| `v.union([a, b])` | `A \| B` | The first that matches; one `union` issue when none does |
| `v.record(schema)` | `Record<string, T>` | Any keys, values checked |
| `v.money({ currencies?, min?, max? })` | `{ amount: bigint; currency: C }` | Currency upper-cased and checked against ISO 4217 |
| `v.currency(only?)` | `string` / `C` | An ISO 4217 code: `v.currency(['EUR', 'MGA'])` |
| `v.country()` | `string` | ISO 3166-1 alpha-2, upper-cased; `UK`, `EU` and reserved codes rejected |
| `v.phone({ defaultCountry? })` | `string` | Normalised to E.164 (`+261341234567`); with `defaultCountry`, national numbers too (MG, FR, IT, GB, US and ~20 more) |
| `v.file({ maxSize?, types? })` | `File` | Size and type; for PDF, PNG, JPEG, GIF and WebP the **bytes** are checked too |
| `v.unknown()` | `unknown` | Anything (to validate later, or pass through) |

### Modifiers on every schema

```ts
v.string().optional()                 // string | undefined; in an object the key becomes optional (key?:)
v.string().nullable()                 // string | null
v.int().default(1)                    // used when the input is undefined; the output is never undefined
v.array(v.string()).default(() => []) // a function for a fresh value each time
v.string().describe('Shown to AI agents and in JSON Schema')
v.string().transform((s) => s.split(',').map((t) => t.trim()))  // map the parsed value (the output type follows)
```

### Rules of your own: `refine`

```ts
const Password = v.string().min(12).refine((p) => /\d/.test(p), { message: 'validation.password_digit' })

// across fields: refine the object, and say which field the error belongs to
export const DateRange = v
  .object({ from: v.date(), to: v.date() })
  .refine((r) => r.to >= r.from, { path: ['to'], message: 'validation.after', params: { other: 'from' } })

// async rules (a lookup, an API) use refineAsync; they need parseAsync(), which request.validate() uses
const Coupon = v.string().refineAsync(async (code) => (await coupons.find(code)) !== null, { message: 'coupons.unknown' })
```

`params` fill the message's placeholders (`"Must be after {other}."`).

### Objects: unknown keys, reuse

```ts
const Traveller = v.object({ name: v.string(), email: v.email(), phone: v.phone().optional() })

Traveller.strict()                    // unknown keys are an error instead of being dropped
Traveller.passthrough()               // unknown keys are kept as they are
Traveller.partial()                   // every key optional: a PATCH body
Traveller.pick('name', 'email')       // a subset
Traveller.omit('phone')
Traveller.extend({ nationality: v.country() })   // add or replace keys
Traveller.shape.email                 // the field schemas, to reuse one
```

### Types

```ts
type Traveller = v.infer<typeof Traveller>   // after parsing (defaults applied, transforms run)
type TravellerForm = v.input<typeof Traveller> // before parsing: what a form holds (optional where a default is)
```

### Strings from forms, query strings and env vars

`request.validate()` converts form and query-string values to what the schema expects (numbers, booleans,
dates), so `v.int()` works on `?page=2`. Outside a request, use the explicit coercing builders:

```ts
v.coerce.int()       // '42' → 42
v.coerce.boolean()   // '1', 'on', 'true', 'yes' → true; '0', 'off', 'false', 'no', '' and absent → false
v.coerce.date()      // an ISO string, a Date or epoch ms → Date
v.coerce.string(), v.coerce.number(), v.coerce.bigint()
```

`env.ts` uses them for environment variables (guide 04).

## Where the input comes from

| Method | Fields |
|---|---|
| `GET`, `HEAD` | the query string |
| others | the JSON body, a form body, or multipart (files included) |
| `request.validate(V, { from: 'query' })` / `{ from: 'body' }` | explicit |

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

  /** Runs after the schema passes. Add errors with `fail`. (No `override` needed.) */
  async after(data: v.infer<this['schema']>, fail: Fail) {
    if (await this.operators.existsBy({ email: data.email })) fail('email', 'validation.unique')
    if (await this.operators.existsBy({ licenceNumber: data.licenceNumber })) fail('licenceNumber', 'operators.licence_taken')
  }
}
```

`request.validate(RegisterOperatorValidator)` resolves it from the request's container and returns the same
inferred type.

## Outside a request

```ts
import { validate, ValidationError } from '@cslug/validation'

const data = await validate(StoreTripRequestValidator, input)   // a schema, a Validator, or any Standard Schema
StoreTripRequestValidator.parse(input)                          // sync; throws ValidationError
const result = StoreTripRequestValidator.safeParse(input)       // { success: true, data } | { success: false, error }
await Coupon.parseAsync(input)                                  // needed when a rule is async
```

Throw a validation error yourself (a 422 with that field's message, like any other):

```ts
if (!(await auth.attempt(email, password))) throw new ValidationError({ email: ['auth.failed'] })
```

`error.issues` are `{ path, code, message, params }`; `error.errors` maps dot paths to message keys;
`error.messages(translate?)` to human text.

## Error messages and i18n

Messages are translation keys resolved in the request's locale. English fallbacks are built in; translate the
keys you show:

```json
// resources/lang/fr.json
{
  "validation": {
    "required": "Ce champ est obligatoire.",
    "unique": "Cette valeur est déjà utilisée.",
    "int.max": "Doit être au plus {max}.",
    "after": "Doit être après {other}."
  },
  "operators": { "licence_taken": "Cette licence est déjà enregistrée." }
}
```

Keys are `validation.<code>` (`validation.required`, `validation.string.min`, `validation.int.max`, …). Override
per field with `{ message: 'key' }`: `v.literal(true, { message: 'bookings.terms_required' })`.

`date().future()` and `.past()` compare with today **in the app's time zone** (`app.timezone`): core sets it from
its `Clock` at boot (`configure({ today })` if you use the package alone).

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

## Live validation

Forms can check a field while the user types (`form.validate('email')` in `@cslug/vue`, see
[guide 08](./08-views-vue-scss.md#live-validation)). Rules that only the server can check (a unique email) need the
route to say which schema it validates with:

```ts
r.post('/register', [RegisterController, 'store']).name('register.store').validates(RegisterValidator)
```

A validate-only request (`X-Cslug-Validate: email`) runs the route's middleware (session, CSRF, throttle) and
`RegisterValidator`, answers `204` or `422` with that field's errors only, and **never calls the controller**: no
user is created. The controller still validates as usual. Routes without `.validates()` refuse such requests (400).

## Files

```ts
export const UploadLicenceValidator = v.object({
  document: v.file({ maxSize: '10mb', types: ['application/pdf', 'image/jpeg', 'image/png'] }), // type sniffed from bytes
  expiresOn: v.date().future(),
})
```

A file whose bytes are not what its name or `Content-Type` claim is refused, so a renamed executable does not pass
as a PDF. Storing it is guide 17.

## JSON Schema and Standard Schema

```ts
StoreTripRequestValidator.toJSONSchema()      // draft 2020-12: used by `cslug describe` and AI tools (guide 18)
```

`.describe()` texts become `description`s, `v.secret()` becomes `writeOnly`. Every schema also implements
[Standard Schema](https://standardschema.dev), and `request.validate()` / `validate()` accept any Standard
Schema (Zod, Valibot, ArkType), but `v` is the documented default.

The reference is [`packages/validation/docs/api.md`](../packages/validation/docs/api.md).
