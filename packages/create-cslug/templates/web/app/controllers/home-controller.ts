import { inject } from '@cslug/core'
import type { HttpContext } from '@cslug/http'
import { view } from '@cslug/vue'
import Dashboard from '#views/dashboard.vue'
import Home from '#views/home.vue'

@inject()
export class HomeController {
  async index() {
    return view(Home, {})
  }

  async dashboard({ auth }: HttpContext) {
    return view(Dashboard, { name: auth.user().name })
  }
}
