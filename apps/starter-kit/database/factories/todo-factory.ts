import { factory } from '@cslug/database'
import { todos } from '#app/tables/todo-table'
import { UserFactory } from './user-factory'

export const TodoFactory = factory(todos, ({ seq, fake }) => ({
  userId: () => UserFactory.create().then((u) => u.id),
  title: `Todo ${seq}: ${fake.sentence(4)}`,
  priority: fake.pick(['low', 'normal', 'high'] as const),
}))
  .state('done', ({ clock }) => ({ completedAt: clock.now() }))
  .state('dueToday', ({ clock }) => ({ dueOn: clock.today() }))
  .state('overdue', ({ clock }) => ({ dueOn: clock.today(-3) }))
