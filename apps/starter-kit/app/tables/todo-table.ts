import { table, id, uuid, text, date, timestamp, timestamps, type Row } from '@cslug/database'
import { users } from './user-table'

export const TodoPriority = ['low', 'normal', 'high'] as const
export type TodoPriority = (typeof TodoPriority)[number]

export const todos = table('todos', {
  id: id(),
  userId: uuid().references(() => users, { onDelete: 'cascade' }),
  title: text(),
  notes: text().nullable(),
  priority: text().oneOf(TodoPriority).default('normal'),
  dueOn: date().nullable(),                     // 'YYYY-MM-DD'
  completedAt: timestamp().nullable(),
  remindedAt: timestamp().nullable(),
  ...timestamps(),
}, {
  indexes: (t) => [t.index('userId', 'completedAt'), t.index('dueOn')],
})

export type Todo = Row<typeof todos>
