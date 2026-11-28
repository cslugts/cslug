# Service providers

A provider is the one place where a subsystem is **wired**: bindings, connections, event listeners,
shutdown. App code rarely needs one; you write a provider when you bind an abstract class, open a
connection, or need to run something at boot.

## Anatomy

```ts
// app/providers/payment-service-provider.ts
import { Logger, ServiceProvider, config } from '@cslug/core'
import { DatabaseProvider } from '@cslug/database'
import { PaymentGateway } from '#app/services/payment-gateway'
import { MangopayGateway } from '#app/services/mangopay-gateway'
import { FakePaymentGateway } from '#app/services/fake-gateway'

export class PaymentServiceProvider extends ServiceProvider {
  static dependsOn = [DatabaseProvider]

  /** Bind only. Nothing is resolved here. */
  register() {
    this.app.singleton(PaymentGateway, () =>
      config('payments.driver') === 'fake'
        ? new FakePaymentGateway()
        : new MangopayGateway(config('payments.mangopay'), this.app.resolve(Logger)),   // a factory resolves when first used
    )
  }

  /** Everything is registered; other providers have booted. */
  async boot() {
    if (config('app.env') === 'production') await this.app.resolve(PaymentGateway).ping()
  }

  /** Reverse boot order, on SIGTERM / SIGINT. */
  async shutdown() {}
}
```

Add it to the list:

```ts
// bootstrap/providers.ts
export const providers = [
  ...defaultProviders,          // one per installed @cslug/* package: database, redis, queue, mail, auth, http, vue, …
  PaymentServiceProvider,
]
```

## The contract

| Hook | Runs | May |
|---|---|---|
| `register()` | Once, synchronously, for every provider before any `boot()` | Call `this.app.singleton/scoped/bind/instance/tag`. Must not resolve |
| `boot()` | After all `register()`s, in dependency order | Resolve services, connect, listen to events, warm caches |
| `shutdown()` | Reverse boot order | Close connections, flush buffers |

- Order comes from `static dependsOn` (and the list's order where dependencies allow). Cycles, duplicates and
  dependencies missing from the list fail at start-up with the chain printed.
- `register()` must not resolve: another provider may not have bound what you need yet (`ProviderError`). Bind a
  factory instead: it runs when the service is first resolved, after every provider registered.
- If any `boot()` throws, providers that already booted are shut down in reverse, then the error is rethrown as a
  `ProviderError` whose `cause` is the original.
- `shutdown()` runs on SIGTERM / SIGINT (under `cslug serve`, `start` and workers) and on `app.shutdown()`; errors
  are collected so every provider gets its turn.
- Commands that need no app (`make:*`, `key:generate`) declare `static boot = false` and start nothing.

## Contributing commands and `describe` sections

A provider is also how a module adds `cslug` commands and a section to `cslug describe` (the app as data for people,
scripts and AI agents):

```ts
import { ServiceProvider } from '@cslug/core'

export class PaymentServiceProvider extends ServiceProvider {
  register() {
    this.commands([PaymentsReconcileCommand, PaymentsRefundCommand])   // `cslug payments:reconcile`, …
    this.describe('payments', () => ({                                 // `cslug describe payments`
      driver: config('payments.driver'),
      stages: config('payments.stages'),
    }))
  }
}
```

App commands in `app/commands/` are found without this (guide 20); `this.commands` is for packages and modules
that live elsewhere.

## The application

`bootstrap/app.ts` builds it (guide 04); the CLI, the web process, workers and the test kit all start it the same way:

```ts
const app = createApp()          // new Application({ root, configs }).useProviders(providers)
await app.start()                // register() all, then boot() in order
app.resolve(EscrowService)
await app.shutdown()             // reverse order; idempotent
```

`app.start({ signals: true })` also installs SIGTERM / SIGINT handlers that shut down and exit (the web process
and workers do this). `app.isRunning` tells whether it started.

## Small apps: `AppServiceProvider`

`bun create cslug` ships `app/providers/app-service-provider.ts` for one-off wiring, so you don't need a
provider for every binding:

```ts
import { config, ServiceProvider } from '@cslug/core'

export class AppServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(WhatsappClient, () => new WhatsappClient(config('whatsapp')))
  }
}
```

Split it into domain providers once it grows past a screen.

## Reference

```ts
import { ServiceProvider, Application, type ProviderHooks, HEALTH_CHECKS, healthCheck } from '@cslug/core'
```

Generator: `cslug make:provider Payments` → `app/providers/payments-provider.ts`.
