# @cslug/core

The application, the container with `@inject`, service providers, and the ambient context. Config, env, events,
the logger, typed errors, `Clock`, `Money` and i18n are added in the next M1 steps.

```ts
import { Application, inject, ServiceProvider } from '@cslug/core'

abstract class PaymentGateway {
  abstract createHold(input: HoldInput): Promise<Hold>
}

@inject(BookingRepository, PaymentGateway)            // checked against the constructor by tsc
export class EscrowService {
  constructor(private bookings: BookingRepository, private gateway: PaymentGateway) {}
}

export class PaymentServiceProvider extends ServiceProvider {
  static dependsOn = [DatabaseProvider]
  register() {
    this.app.singleton(PaymentGateway, MangopayGateway)
  }
}

const app = await new Application({ root: import.meta.dir }).useProviders([DatabaseProvider, PaymentServiceProvider]).start()
const escrow = app.createScope().resolve(EscrowService)
```

- Full reference: [api.md](./api.md)
- Guides: [02 Container & `@inject`](../../../guides/02-container-and-di.md), [03 Service providers](../../../guides/03-service-providers.md)
