import { inject, Clock, Cache } from '@cslug/core'
import { Database } from '@cslug/database'
import { TodoRepository } from '#app/repositories/todo-repository'
import { TodoCompleted } from '#app/events/todo-completed'
import type { Todo } from '#app/tables/todo-table'
import type { v } from '@cslug/validation'
import type { StoreTodoValidator } from '#app/validators/store-todo-validator'
import type { UpdateTodoValidator } from '#app/validators/update-todo-validator'

@inject(Database, TodoRepository, Cache, Clock)
export class TodoService {
  constructor(
    private db: Database,
    private todos: TodoRepository,
    private cache: Cache,
    private clock: Clock,
  ) {}

  create(userId: string, data: v.infer<typeof StoreTodoValidator>) {
    return this.todos.create({ userId, ...data })
  }

  update(todo: Todo, data: v.infer<typeof UpdateTodoValidator>) {
    return this.todos.update(todo.id, data)
  }

  /** Toggle done/open. Emits TodoCompleted when a todo gets completed. */
  async toggle(todo: Todo) {
    return this.db.transaction(async () => {
      const current = await this.todos.lockForUpdate(todo.id)
      const completing = current.completedAt === null
      const updated = await this.todos.update(current.id, { completedAt: completing ? this.clock.now() : null })
      if (completing) await TodoCompleted.emit({ todoId: updated.id, userId: updated.userId })
      return updated
    })
  }

  delete(todo: Todo) {
    return this.todos.delete(todo.id)
  }

  stats(userId: string) {
    return this.cache.remember(`todos:stats:${userId}`, '5m', () => this.todos.stats(userId))
  }
}
