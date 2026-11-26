import { inject, ValidationError } from '@cslug/core'
import { type HttpContext, redirect, route } from '@cslug/http'
import { view } from '@cslug/vue'
import { LoginValidator } from '#app/validators/login-validator'
import Login from '#views/auth/login.vue'

@inject()
export class SessionController {
  async create() {
    return view(Login, {})
  }

  async store({ request, auth }: HttpContext) {
    const { email, password } = await request.validate(LoginValidator)
    const user = await auth.attempt(email, password) // throttled; failures logged without the password
    if (!user) throw new ValidationError({ email: ['auth.failed'] })
    return redirect().intended(route('dashboard'))
  }

  async destroy({ auth }: HttpContext) {
    await auth.logout()
    return redirect().to(route('home'))
  }
}
