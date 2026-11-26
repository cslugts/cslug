import { inject } from '@cslug/core'
import { type Fail, Validator, v } from '@cslug/validation'
import { UserRepository } from '#app/repositories/user-repository'

@inject(UserRepository)
export class RegisterValidator extends Validator {
  constructor(private users: UserRepository) {
    super()
  }

  schema = v
    .object({
      name: v.string().trim().min(2).max(80),
      email: v.email().toLowerCase(),
      password: v.string().min(12).max(200),
      passwordConfirmation: v.string(),
    })
    .refine((d) => d.password === d.passwordConfirmation, {
      path: ['passwordConfirmation'],
      message: 'auth.password_mismatch',
    })

  async after(data: v.infer<this['schema']>, fail: Fail) {
    if (await this.users.existsBy({ email: data.email })) fail('email', 'validation.unique')
  }
}
