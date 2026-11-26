import { defineConfig } from '@cslug/core'
import { UserRepository } from '#app/repositories/user-repository'

export default defineConfig({
  users: UserRepository,
  guards: {
    web: { driver: 'session' },
    token: { driver: 'token', abilities: true },
  },
  passwords: { algorithm: 'argon2id', rehashOnLogin: true },
})
