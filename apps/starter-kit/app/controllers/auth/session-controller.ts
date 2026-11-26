import { inject } from '@cslug/core'
import { type HttpContext, redirect, route } from '@cslug/http'
import { view } from '@cslug/vue'
import { ValidationError } from '@cslug/validation'
import Login from '#views/auth/login.vue'
import { LoginValidator } from '#app/validators/login-validator'

@inject()
export class SessionController {
  async create() {
    return view(Login, {})
  }

  async store({ request, auth }: HttpContext) {
    const { email, password, remember } = await request.validate(LoginValidator)
    const user = await auth.attempt(email, password, { remember })      // throttled; failures logged without the password
    if (!user) throw new ValidationError({ email: ['auth.failed'] })
    return redirect().intended(route('todos.index'))
  }

  async destroy({ auth }: HttpContext) {
    await auth.logout()
    return redirect().to(route('login'))
  }
}
