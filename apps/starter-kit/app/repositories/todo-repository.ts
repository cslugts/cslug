import { inject } from '@cslug/core'
import { Repository, sql, lte, notNull, inList } from '@cslug/database'
import { todos, type TodoPriority } from '#app/tables/todo-table'
import { users } from '#app/tables/user-table'

export type TodoFilter = 'all' | 'open' | 'done'

@inject()
export class TodoRepository extends Repository(todos) {
  /** A user's todos: open first, then by due date and priority. */
  forUser(userId: string, filter: TodoFilter = 'all') {
    const query = this.where({
      userId,
      ...(filter === 'open' && { completedAt: null }),
      ...(filter === 'done' && { completedAt: notNull() }),
    })
    return query.orderBy('completedAt', 'asc', { nulls: 'first' }).orderBy('dueOn', 'asc', { nulls: 'last' }).all()
  }

  /** Counts for the header, in one query. */
  async stats(userId: string) {
    return this.db.one(sql<{ open: number; done: number; overdue: number }>`
      select count(*) filter (where ${todos.c.completedAt} is null)::int as open,
             count(*) filter (where ${todos.c.completedAt} is not null)::int as done,
             count(*) filter (where ${todos.c.completedAt} is null and ${todos.c.dueOn} < current_date)::int as overdue
      from ${todos}
      where ${todos.c.userId} = ${userId}`)
  }

  /** Open todos due on or before `day` that have not been reminded yet, with their owner. Join → tagged SQL. */
  dueForReminder(day: string) {
    return this.db.many(sql<{ todoId: string; title: string; dueOn: string; priority: TodoPriority; userId: string; email: string; name: string; locale: string }>`
      select ${todos.c.id} as todo_id, ${todos.c.title}, ${todos.c.dueOn}, ${todos.c.priority},
             ${users.c.id} as user_id, ${users.c.email}, ${users.c.name}, ${users.c.locale}
      from ${todos}
      join ${users} on ${users.c.id} = ${todos.c.userId}
      where ${todos.c.completedAt} is null
        and ${todos.c.remindedAt} is null
        and ${todos.c.dueOn} <= ${day}
      order by ${users.c.id}, ${todos.c.dueOn}`)
  }

  markReminded(ids: string[], at: Date) {
    return this.where({ id: inList(ids) }).update({ remindedAt: at })
  }

  purgeCompletedBefore(cutoff: Date) {
    return this.where({ completedAt: lte(cutoff) }).delete()
  }
}

