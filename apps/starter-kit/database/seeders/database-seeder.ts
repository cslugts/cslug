import { seeder } from '@cslug/database'
import { UserFactory } from '#database/factories/user-factory'
import { TodoFactory } from '#database/factories/todo-factory'

export default seeder(async () => {
  const demo = await UserFactory.create({ name: 'Demo', email: 'demo@example.test' })
  await TodoFactory.for({ userId: demo.id }).createMany(5)
  await TodoFactory.for({ userId: demo.id }).state('done').createMany(3)
  await TodoFactory.for({ userId: demo.id }).state('overdue').create({ title: 'Renew passport' })
})
