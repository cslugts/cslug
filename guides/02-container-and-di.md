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
import { inject } from '@cslug/core'
import { Database } from '@cslug/database'

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
import { inject } from '@cslug/core'

@inject()
export class SlugGenerator {}
```

### Controllers, jobs, listeners, policies, commands, agents, tools

They are all the same: list the constructor's dependencies.

```ts
import { inject } from '@cslug/core'
import { Notifier } from '@cslug/notification'
import { Job } from '@cslug/queue'

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
import { config, inject, token } from '@cslug/core'

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
import { inject, Money } from '@cslug/core'

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
import { Clock, inject, Logger, resolve } from '@cslug/core'

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
import { Logger } from '@cslug/core'

const escrow = new EscrowService(fakeDb, new FakePaymentGateway(), Logger.null())
```

## Lifetimes

| Lifetime | Meaning | How |
|---|---|---|
| **scoped** (default) | One instance per request / job / command | `@inject(...)` or `app.scoped(X)` |
| **singleton** | One instance per application | `@inject.singleton(...)` or `app.singleton(X)` |
| **transient** | New instance each time | `@inject.transient(...)` or `app.bind(X, factory)` |

```ts
import { Logger } from '@cslug/core'

@inject.singleton(Logger)                 // one per app: holds a connection, a cache, a rate table
export class ExchangeRates {
  constructor(private log: Logger) {}
}

@inject.transient()                       // a fresh one per resolve: a builder with state
export class InvoiceBuilder {}
```

A singleton that depends on a scoped class throws `ScopeViolationError` at resolve time, because it would capture
the first request's instance.

### Scopes and cleanup

Each request, job and command runs in its own **scope**, a child container: scoped instances live and die with it.
When the scope ends, instances that implement `Symbol.asyncDispose` (or `Symbol.dispose`) are disposed, newest
first, so a per-request resource closes itself:

```ts
import { inject } from '@cslug/core'
import { Storage } from '@cslug/storage'

@inject(Storage)
export class UploadSession {
  private temp: string[] = []
  constructor(private storage: Storage) {}
  // …
  async [Symbol.asyncDispose]() {
    for (const path of this.temp) await this.storage.disk('local').delete(path)   // after the response is sent
  }
}
```

Your own code rarely makes scopes; scripts and tests can: `const scope = app.createScope()`, then
`scope.resolve(X)` and `await scope.dispose()`.

## `resolve()` outside a constructor

```ts
import { resolve } from '@cslug/core'

const escrow = resolve(EscrowService)      // uses the current request/job scope
```

For base classes, route closures, the REPL and scripts.

## Binding by hand

Providers (guide 03) bind what the container cannot build on its own:

```ts
import { config, Logger } from '@cslug/core'

this.app.singleton(PaymentGateway, MangopayGateway)                   // a class (built with its @inject list)
this.app.singleton(PaymentGateway, (c) => new MangopayGateway(config('payments.mangopay'), c.resolve(Logger)))
this.app.scoped(CurrentOperator, (c) => c.resolve(OperatorResolver).current())   // one per request
this.app.bind(PdfRenderer, () => new PdfRenderer({ margin: 12 }))     // transient
this.app.instance(COMMISSION_PERCENT, 8)                              // an existing value
this.app.has(PaymentGateway)                                          // bound (or an @inject class)?
this.app.build(ReportExporter)                                        // build one with its deps, without caching it
```

## Contextual and tagged bindings

```ts
this.app.when(PublicCircuitController).needs(CircuitRepository).give(CachedCircuitRepository)

this.app.tag([VisaPageChecker, OperatorLicenceChecker], 'compliance.checks')
const checks = this.app.tagged<ComplianceCheck>('compliance.checks')
```

## Swapping in tests

```ts
import { testApp } from '@cslug/testing'

const app = testApp()
app.swap(PaymentGateway, new FakePaymentGateway({ failNextRelease: true }))   // until the end of the test
```

## Errors that say how to fix

```
BindingNotFoundError: Cannot resolve PaymentGateway
  required by EscrowService
  required by BookingController
  Hint: if PaymentGateway is a class you wrote, add @inject(...) to it.
        If it is abstract (an interface), bind an implementation in a provider:
        this.app.singleton(PaymentGateway, YourPaymentGatewayImplementation)
```

Other container errors are just as explicit:

| Error | When |
|---|---|
| `CircularDependencyError` | `A → B → A`, with the full chain |
| `ScopeViolationError` | A singleton depends on a scoped class |
| `ProviderError` | `resolve()` called inside a provider's `register()`, duplicate or missing providers, provider cycles, a failing `boot()` |

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
import { inject } from '@cslug/core'
import { Database } from '@cslug/database'

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

## Reference

```ts
import { inject, token, resolve, Container, Application, type Token, BindingNotFoundError, CircularDependencyError,
  ScopeViolationError } from '@cslug/core'
```
