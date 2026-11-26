import { inject } from '@cslug/core'
import { Policy } from '@cslug/auth'
import type { User } from '#app/tables/user-table'
import type { Todo } from '#app/tables/todo-table'

@inject()
export class TodoPolicy extends Policy {
  view(user: User, todo: Todo) {
    return todo.userId === user.id
  }

  update(user: User, todo: Todo) {
    return todo.userId === user.id
  }

  delete(user: User, todo: Todo) {
    return todo.userId === user.id
  }
}
