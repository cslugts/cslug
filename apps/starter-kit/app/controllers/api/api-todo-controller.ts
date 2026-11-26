import { inject } from '@cslug/core'
import { type HttpContext, created } from '@cslug/http'
import { TodoRepository } from '#app/repositories/todo-repository'
import { TodoService } from '#app/services/todo-service'
import { StoreTodoValidator } from '#app/validators/store-todo-validator'
import { todoTransformer } from '#app/transformers/todo-transformer'

/** Token API: `Authorization: Bearer <token>` with the `todos:read` / `todos:write` abilities. */
@inject(TodoRepository, TodoService)
export class ApiTodoController {
  constructor(private todos: TodoRepository, private service: TodoService) {}

  async index({ auth }: HttpContext) {
    const list = await this.todos.forUser(auth.user().id)
    return { data: list.map(todoTransformer) }
  }

  async store({ request, auth }: HttpContext) {
    const todo = await this.service.create(auth.user().id, await request.validate(StoreTodoValidator))
    return created({ data: todoTransformer(todo) })
  }
}
