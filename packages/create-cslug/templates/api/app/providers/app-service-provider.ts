import { ServiceProvider } from '@cslug/core'

/** One-off wiring for the app. Split into more providers when it grows past a screen. */
export class AppServiceProvider extends ServiceProvider {
  register() {
    // bindings go here, e.g. this.app.singleton(PaymentGateway, StripeGateway)
  }
}
