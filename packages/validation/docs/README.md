# @cslug/validation

Schemas and validators with a Zod-like API and **no dependencies**. Every schema implements
[Standard Schema](https://standardschema.dev) and exports JSON Schema, so the same definition validates HTTP
input, job payloads, env vars, AI tool inputs and AI structured output.

```ts
import { v } from '@cslug/validation'

export const StoreTripRequestValidator = v.object({
  circuitId: v.uuid(),
  startDate: v.date().future(),                            // 'YYYY-MM-DD'
  groupSize: v.int().min(1).max(12),
  budget: v.money({ currencies: ['EUR', 'USD', 'GBP'] }),  // { amount: bigint, currency }
  email: v.email().toLowerCase(),
  whatsapp: v.phone().optional(),                          // normalised to E.164
})

type StoreTripRequest = v.infer<typeof StoreTripRequestValidator>

const data = StoreTripRequestValidator.parse(input)        // or safeParse / parseAsync
```

Errors are `ValidationError` (status 422) with **translation keys**, so messages follow the request's locale:

```ts
try { Schema.parse(input) } catch (e) {
  e.errors      // { groupSize: ['validation.int.max'] }
  e.messages()  // { groupSize: ['Must be at most 12.'] }  (or pass a translator)
}
```

When validation needs services (database checks), write a `Validator` class. The container builds it, and
`after()` runs once the schema passed:

```ts
@inject(OperatorRepository)
export class RegisterOperatorValidator extends Validator {
  constructor(private operators: OperatorRepository) { super() }
  schema = v.object({ email: v.email() })
  async after(data: v.infer<this['schema']>, fail: Fail) {
    if (await this.operators.existsBy({ email: data.email })) fail('email', 'validation.unique')
  }
}
```

- Full reference: [api.md](./api.md)
- How it's used in apps: [guides/07-validation.md](../../../guides/07-validation.md)
