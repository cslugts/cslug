import { inject, t } from '@cslug/core'
import { type HttpContext, redirect, route } from '@cslug/http'
import { view } from '@cslug/vue'
import { Hash } from '@cslug/auth'
import Register from '#views/auth/register.vue'
import { RegisterValidator } from '#app/validators/register-validator'
import { UserRepository } from '#app/repositories/user-repository'

@inject(UserRepository, Hash)
export class RegisterController {
  constructor(private users: UserRepository, private hash: Hash) {}

  async create() {
    return view(Register, {})
  }

  async store({ request, auth, locale }: HttpContext) {
    const { name, email, password } = await request.validate(RegisterValidator)
    const user = await this.users.create({ name, email, locale, passwordHash: await this.hash.make(password) })
    await auth.login(user)
    return redirect().to(route('todos.index')).with('success', t('auth.welcome', { name }))
  }
}
