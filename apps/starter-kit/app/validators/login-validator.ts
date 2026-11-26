import { v } from '@cslug/validation'

export const LoginValidator = v.object({
  email: v.email().toLowerCase(),
  password: v.string().min(1),
  remember: v.coerce.boolean().default(false),
})
