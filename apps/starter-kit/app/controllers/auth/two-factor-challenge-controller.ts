import { inject } from '@cslug/core'
import { type HttpContext, redirect, route } from '@cslug/http'
import { view } from '@cslug/vue'
import { ValidationError } from '@cslug/validation'
import TwoFactor from '#views/auth/two-factor.vue'
import { TwoFactorValidator } from '#app/validators/two-factor-validator'

/** The second step of a login with two-factor authentication (`auth.attempt()` left it waiting for a code). */
@inject()
export class TwoFactorChallengeController {
  async create({ auth }: HttpContext) {
    if (!auth.twoFactorPending) return redirect().to(route('login'))   // nothing to confirm, or it expired
    return view(TwoFactor, {})
  }

  async store({ request, auth }: HttpContext) {
    const { code } = await request.validate(TwoFactorValidator)
    // a code from the authenticator app or a recovery code; throttled, used once
    if (!(await auth.completeTwoFactor(code))) throw new ValidationError({ code: ['auth.two_factor_failed'] })
    return redirect().intended(route('todos.index'))
  }
}
