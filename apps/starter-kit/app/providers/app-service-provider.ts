import { ServiceProvider } from '@cslug/core'
import { gate } from '@cslug/auth'

/** One-off wiring for the app. Split into more providers when it grows past a screen. */
export class AppServiceProvider extends ServiceProvider {
  register() {
    // bindings go here, e.g. this.app.singleton(PaymentGateway, StripeGateway)
  }

  boot() {
    gate.define('api.tokens.create', (user) => user.emailVerifiedAt !== null)
  }
}
