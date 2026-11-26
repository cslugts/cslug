import { defineConfig } from '@cslug/core'
import { UserRepository } from '#app/repositories/user-repository'

export default defineConfig({
  users: UserRepository,
  passwords: { algorithm: 'argon2id', rehashOnLogin: true },
})
