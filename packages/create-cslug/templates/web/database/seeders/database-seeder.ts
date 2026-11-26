import { seeder } from '@cslug/database'
import { UserFactory } from '#database/factories/user-factory'

/** `cslug db:seed`: development data. Log in as demo@example.test / password-password. */
export default seeder(async () => {
  await UserFactory.create({ name: 'Demo', email: 'demo@example.test' })
})
