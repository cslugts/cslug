import { NotFoundError, ServiceProvider } from '@cslug/core'
import { ExceptionHandler } from '@cslug/http'
import { view } from '@cslug/vue'
import NotFound from '#views/errors/404.vue'

/** One-off wiring for the app. Split into more providers when it grows past a screen. */
export class AppServiceProvider extends ServiceProvider {
  register() {
    // bindings go here, e.g. this.app.singleton(PaymentGateway, StripeGateway)
  }

  boot() {
    // pages get the app's own 404 page (resources/views/errors/404.vue); API clients keep the JSON problem
    this.app.resolve(ExceptionHandler).render((error, ctx) => {
      if (error instanceof NotFoundError && !ctx.request.wantsJson())
        return view(NotFound, {}, { status: 404 }).toResponse(ctx)
    })
  }
}
