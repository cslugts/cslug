import { Hash } from '@cslug/auth'
import { inject, t } from '@cslug/core'
import { type HttpContext, redirect, route } from '@cslug/http'
import { Mailer } from '@cslug/mail'
import { view } from '@cslug/vue'
import { WelcomeMail } from '#app/mail/welcome-mail'
import { UserRepository } from '#app/repositories/user-repository'
import { RegisterValidator } from '#app/validators/register-validator'
import Register from '#views/auth/register.vue'

@inject(UserRepository, Hash, Mailer)
export class RegisterController {
  constructor(
    private users: UserRepository,
    private hash: Hash,
    private mailer: Mailer,
  ) {}

  async create() {
    return view(Register, {})
  }

  async store({ request, auth }: HttpContext) {
    const { name, email, password } = await request.validate(RegisterValidator)
    const user = await this.users.create({ name, email, passwordHash: await this.hash.make(password) })
    await this.mailer.to(user).send(new WelcomeMail(name))
    await auth.login(user)
    return redirect().to(route('dashboard')).with('success', t('auth.welcome', { name }))
  }
}
