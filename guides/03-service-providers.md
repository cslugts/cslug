# Service providers

A provider is the one place where a subsystem is **wired**: bindings, connections, event listeners,
shutdown. App code rarely needs one; you write a provider when you bind an abstract class, open a
connection, or need to run something at boot.

## Anatomy

```ts
// app/providers/payment-service-provider.ts
import { ServiceProvider, config } from '@cslug/core'
import { DatabaseProvider } from '@cslug/database'
import { HttpClient } from '@cslug/http'
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
        : new MangopayGateway(config('payments.mangopay'), this.app.resolve(HttpClient)),
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

- Order comes from `static dependsOn`. Cycles, duplicates and missing dependencies fail at start-up with the
  chain printed.
- If any `boot()` throws, providers that already booted are shut down, then the error is rethrown.
- Commands can boot fewer providers: a command declares `static providers = 'all' | 'minimal' | [...]`.

## Small apps: `AppServiceProvider`

`bun create cslug` ships `app/providers/app-service-provider.ts` for one-off wiring, so you don't need a
provider for every binding:

```ts
export class AppServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(WhatsappClient, () => new WhatsappClient(config('whatsapp')))
  }
}
```

Split it into domain providers once it grows past a screen.
