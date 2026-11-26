import { factory } from '@cslug/database'
import { users } from '#app/tables/user-table'

/** Every factory user has the password "password-password". */
export const UserFactory = factory(users, ({ seq, fake }) => ({
  name: fake.name(),
  email: `user${seq}@example.test`,
  passwordHash: fake.passwordHash('password-password'),
  locale: 'en' as const,
})).state('unverified', { emailVerifiedAt: null })
