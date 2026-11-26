# @cslug/validation: API

Everything below is exported from `@cslug/validation`.

## `v`: schema builders

| Builder | Output type | Accepts | Notes |
|---|---|---|---|
| `v.string()` | `string` | string | |
| `v.email()` | `string` | string | Trimmed, checked |
| `v.url()` | `string` | string | Any absolute URL (`https:`, `postgres:`, `redis:` …) except `javascript:`, `data:`, `vbscript:`, `file:`, `blob:`. Narrow it with `.protocols('https:')` |
| `v.uuid()` / `v.uuid7()` | `string` | string | `uuid7` checks the version nibble |
| `v.secret()` | `string` | string | Marked secret: redacted by the logger, `writeOnly` in JSON Schema |
| `v.number()` / `v.int()` | `number` | finite number | `int` = safe integer |
| `v.bigint()` / `v.amount()` | `bigint` | bigint, safe integer, digit string | JSON has no bigint, so amounts travel as `"220000"` |
| `v.boolean()` | `boolean` | boolean | |
| `v.date()` | `string` | `'YYYY-MM-DD'` | Real calendar dates only (Feb 30 is rejected) |
| `v.datetime()` | `Date` | Date, ISO 8601 string | |
| `v.enum(['a', 'b'])` | `'a' \| 'b'` | one of the values | Readonly tuples work: `v.enum(TodoPriority)` |
| `v.literal(x, { message? })` | `x` | exactly `x` | |
| `v.object(shape)` | inferred | plain object | Unknown keys are **stripped** |
| `v.array(schema)` | `T[]` | array | |
| `v.union([a, b])` | `A \| B` | first match | One `union` issue when nothing matches |
| `v.record(schema)` | `Record<string, T>` | plain object | |
| `v.money({ currencies?, min?, max? })` | `{ amount: bigint; currency: C }` | `{ amount, currency }` | Currency upper-cased, ISO 4217 |
| `v.currency(only?)` | `string` / `C` | ISO 4217 code | |
| `v.country()` | `string` | ISO 3166-1 alpha-2 | Upper-cased; `UK`, `EU` and reserved codes rejected |
| `v.phone({ defaultCountry? })` | `string` | phone number | Normalised to E.164. With `defaultCountry`, national numbers too (MG, FR, IT, GB, US and ~20 more) |
| `v.file({ maxSize?, types? })` | `File` | `File` / `Blob` | Size and declared type checked; for PDF, PNG, JPEG, GIF and WebP the **bytes** are checked as well (`parseAsync`) |
| `v.unknown()` | `unknown` | anything | |
| `v.coerce.string/number/int/boolean/bigint/date()` | | strings | For query strings, form posts and env vars. `coerce.boolean`: `'1'/'on'/'true'/'yes'` → true; `'0'/'off'/'false'/'no'/''`/absent → false |

Types: `v.infer<typeof S>` (parsed) and `v.input<typeof S>` (before parsing, e.g. what a form holds).

## Modifiers (every schema)

| Modifier | Effect |
|---|---|
| `.optional()` | Accepts `undefined`. In objects, the key becomes optional (`key?:`) |
| `.nullable()` | Accepts `null` |
| `.default(value \| () => value)` | Used when the input is `undefined`; output is never undefined |
| `.describe(text)` | Exported as JSON Schema `description` |
| `.refine(check, { message?, path?, params? })` | Extra rule on the parsed value |
| `.refineAsync(check, options)` | Async rule; needs `parseAsync()` |
| `.transform(fn)` | Map the parsed value |
| `.parse(x)` / `.safeParse(x)` / `.parseAsync(x)` | Throw / result object / async |
| `.toJSONSchema()` | JSON Schema draft 2020-12 |

Schema-specific: `string().min/max/length/nonempty/regex/trim/toLowerCase/toUpperCase/email/url/protocols/uuid/uuid7` ·
`number().int/min/max/positive/nonnegative` · `bigint().min/max/nonnegative` · `date().future/past/min/max` ·
`array().min/max/nonempty` · `object().strict/passthrough/partial/pick/omit/extend/shape`.

Schemas are **immutable**: every modifier returns a new schema.

## Errors

```ts
class ValidationError extends Error {
  status: 422
  code: 'validation.failed'
  issues: Issue[]
  constructor(input: Issue[] | Record<string, string | string[]>)  // e.g. new ValidationError({ email: ['auth.failed'] })
  get errors(): Record<string, string[]>                           // message keys by dot path
  messages(translate?: Translate): Record<string, string[]>        // human text
}

type Issue = { path: (string | number)[]; code: string; message: string; params?: Record<string, unknown> }
type Translate = (key: string, params: Record<string, unknown>) => string | undefined
```

Message keys are `validation.<code>` (`validation.required`, `validation.int.max`, …) unless the schema has a
custom `message`. `formatMessage(issue, translate?)` and `interpolate(template, params)` are exported for
renderers. English fallbacks are built in.

## Validators

```ts
abstract class Validator {
  abstract readonly schema: Schema
  // optional: after(data, fail): void | Promise<void>, which needs no `override`
  validate(input: unknown): Promise<Output>
}
type Fail = (path: string, message: string, params?: Record<string, unknown>) => void

validate(target: Schema | Validator | StandardSchemaV1, input): Promise<Output<typeof target>>
```

## Configuration

`configure({ today: () => 'YYYY-MM-DD' })`: `@cslug/core` sets this from its `Clock` at boot, so
`date().future()` uses the app's time zone. The default is UTC.

## Standard Schema

Every schema has `'~standard'` (vendor `cslug`). `validate()` accepts any Standard Schema (Zod, Valibot,
ArkType). `StandardSchemaV1` types are exported.
