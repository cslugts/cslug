# Container & `@inject`

The container builds your classes and their dependencies. You mark a class with `@inject(...)`, list what
its constructor needs, and the container does the rest. No registration is needed for app classes.

cslug uses **standard decorators** (TypeScript's default), so there is no `experimentalDecorators` or
`emitDecoratorMetadata` setting and no `reflect-metadata`.

## The basics

```ts
import { inject, Logger, Cache } from '@cslug/core'
import { OperatorRepository } from '#app/repositories/operator-repository'

@inject(OperatorRepository, Cache, Logger)
export class OperatorDirectory {
  constructor(
    private operators: OperatorRepository,
    private cache: Cache,
    private log: Logger,
  ) {}

  verified(circuitId: string) {
    return this.cache.remember(`operators:verified:${circuitId}`, '10m', () => this.operators.verifiedOn(circuitId))
  }
}
```

The list says **what** to inject, and the constructor says **where**. They must match in order and type, and
**`tsc` checks it**:

```ts
@inject(Database)                       // ✗ PaymentGateway is missing
export class EscrowService {
  constructor(private db: Database, private gateway: PaymentGateway) {}
}
// error TS1238: Unable to resolve signature of class decorator when called as an expression.
//   Argument of type 'typeof EscrowService' is not assignable to parameter of type
//   'abstract new (args_0: Database) => unknown'.

@inject(PaymentGateway, Database)       // ✗ wrong order: same error, showing the expected order
```

`cslug make:*` writes the list for you, and when you add a constructor parameter the compiler tells you to add
it to the list too.

## Common cases

### No dependencies

```ts
@inject()
export class SlugGenerator {}
```

### Controllers, jobs, listeners, policies, commands, agents, tools

They are all the same: list the constructor's dependencies.

```ts
@inject(BookingRepository, EscrowService)
export class BookingController {
  constructor(private bookings: BookingRepository, private escrow: EscrowService) {}
}

@inject(BookingRepository, Notifier)
export class SendCheckinJob extends Job<Payload> {
  constructor(private bookings: BookingRepository, private notifier: Notifier) { super() }
}
```

### Values: tokens

```ts
import { token, inject } from '@cslug/core'

export const COMMISSION_PERCENT = token<number>('payments.commission_percent')

// provider
this.app.instance(COMMISSION_PERCENT, config('payments.commissionPercent'))

// consumer: the token goes in the same list, and its type (number) is checked against the parameter
@inject(ExchangeRates, COMMISSION_PERCENT)
export class PricingService {
  constructor(private fx: ExchangeRates, private commission: number) {}
}
```

Prefer `config()` for plain settings. Tokens are for values a provider computes.

### Interfaces: abstract classes

TypeScript interfaces vanish at runtime, so an abstract class is the token:

```ts
export abstract class PaymentGateway {
  abstract createHold(input: HoldInput): Promise<Hold>
  abstract release(holdId: string, amount: Money, payee: Payee): Promise<Transfer>
}

// provider
this.app.singleton(PaymentGateway, MangopayGateway)

// consumer
@inject(PaymentGateway)
export class EscrowService {
  constructor(private gateway: PaymentGateway) {}
}
```

### Base classes: `resolve()` in fields

Field initialisers run inside the container's construction, so a base class can pull its own dependencies
without forcing every subclass to pass them through `super(...)`:

```ts
export abstract class AdminController {
  protected log = resolve(Logger).child({ area: 'admin' })
  protected clock = resolve(Clock)
}

@inject(OperatorRepository)
export class OperatorAdminController extends AdminController {
  constructor(private operators: OperatorRepository) { super() }
}
```

Framework base classes work this way: `Repository(table)` gets its `Database`, `Command` its output, `Job` its
logger. That is why a repository with only table-based methods needs nothing more than `@inject()`.

### Unit tests: plain `new`

```ts
const escrow = new EscrowService(fakeDb, new FakePaymentGateway(), Logger.null())
```

## Lifetimes

| Lifetime | Meaning | How |
|---|---|---|
| **scoped** (default) | One instance per request / job / command | `@inject(...)` |
| **singleton** | One instance per application | `@inject.singleton(...)` or `app.singleton(X)` |
| **transient** | New instance each time | `app.bind(X, factory)` |

A singleton that depends on a scoped class throws `ScopeViolationError` at resolve time, because it would capture
the first request's instance.

## `resolve()` outside a constructor

```ts
const escrow = resolve(EscrowService)      // uses the current request/job scope
```

For base classes, route closures, the REPL and scripts.

## Contextual and tagged bindings

```ts
this.app.when(PublicCircuitController).needs(CircuitRepository).give(CachedCircuitRepository)

this.app.tag([VisaPageChecker, OperatorLicenceChecker], 'compliance.checks')
const checks = this.app.tagged<ComplianceCheck>('compliance.checks')
```

## Swapping in tests

```ts
const app = testApp()
app.swap(PaymentGateway, new FakePaymentGateway({ failNextRelease: true }))   // until the end of the test
```

## Errors that say how to fix

```
BindingNotFoundError: Cannot resolve PaymentGateway
  required by EscrowService (app/services/escrow-service.ts)
  required by BookingController (app/controllers/booking-controller.ts)
  Hint: PaymentGateway is abstract. Bind an implementation in a provider:
        this.app.singleton(PaymentGateway, MangopayGateway)
```

## Limits

- **Circular imports** between two `@inject` classes fail at module load: the list reads the other class before
  it is defined. Extract the shared part into a third class. There is no `forwardRef()`.
- An **extra** item in the list (one the constructor doesn't take) is not a type error, because it is harmless.
  The bundled lint rule flags it.

---

## Why not legacy decorators

Kept for the record (decision [D2](../docs/decisions.md#d2-dependency-injection-standard-decorators-injecta-b-)).
Legacy mode (`experimentalDecorators` + `emitDecoratorMetadata`) lets `@inject()` read the constructor types from
compiler-emitted metadata:

```ts
// legacy (not used)                          // standard (cslug)
@inject()                                      @inject(Database, PaymentGateway)
export class EscrowService {                   export class EscrowService {
  constructor(                                   constructor(
    private db: Database,                          private db: Database,
    private gateway: PaymentGateway,               private gateway: PaymentGateway,
  ) {}                                           ) {}
}                                              }
```

| | Legacy `@inject()` | Standard `@inject(A, B)` |
|---|---|---|
| Keystrokes | Fewer | Each dependency named twice |
| Wiring mistakes found | At runtime | **At compile time** |
| `import type` of a dependency | Silently injects `Object` | **Compile error** |
| Primitives / tokens | Separate syntax (`@inject(T)` on the parameter) | **Same list** |
| Hidden behaviour | Emitted metadata + a shim | **None** |
| Same result in every tool | No (esbuild, for one, emits no metadata) | **Yes** |
| Direction of the language | Legacy, maintained | **The standard** |
