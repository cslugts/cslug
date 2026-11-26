import { inject, t } from '@cslug/core'
import { type HttpContext, redirect } from '@cslug/http'
import { view } from '@cslug/vue'
import TodoIndex from '#views/todos/index.vue'
import { TodoRepository, type TodoFilter } from '#app/repositories/todo-repository'
import { TodoService } from '#app/services/todo-service'
import { TodoPolicy } from '#app/policies/todo-policy'
import { StoreTodoValidator } from '#app/validators/store-todo-validator'
import { UpdateTodoValidator } from '#app/validators/update-todo-validator'

@inject(TodoRepository, TodoService)
export class TodoController {
  constructor(private todos: TodoRepository, private service: TodoService) {}

  async index({ request, auth }: HttpContext) {
    const user = auth.user()
    const filter = (request.query('filter') ?? 'all') as TodoFilter
    return view(TodoIndex, {
      todos: await this.todos.forUser(user.id, filter),
      stats: await this.service.stats(user.id),
      filter,
    })
  }

  /** HTML form post (works without JS) or JSON from the new-todo island. */
  async store({ request, auth }: HttpContext) {
    const data = await request.validate(StoreTodoValidator)
    const todo = await this.service.create(auth.user().id, data)
    if (request.wantsJson()) return { todo }
    return redirect().back().with('success', t('todos.created'))
  }

  async update({ params, request, auth }: HttpContext) {
    const todo = await this.todos.findOrFail(params.todo)
    await auth.authorize(TodoPolicy, 'update', todo)
    const updated = await this.service.update(todo, await request.validate(UpdateTodoValidator))
    if (request.wantsJson()) return { todo: updated }
    return redirect().back().with('success', t('todos.updated'))
  }

  /** Called by the todo-item island with fetch; also works as a plain form post. */
  async toggle({ params, request, auth }: HttpContext) {
    const todo = await this.todos.findOrFail(params.todo)
    await auth.authorize(TodoPolicy, 'update', todo)
    const updated = await this.service.toggle(todo)
    if (request.wantsJson()) return { todo: updated, stats: await this.service.stats(todo.userId) }
    return redirect().back()
  }

  async destroy({ params, request, auth }: HttpContext) {
    const todo = await this.todos.findOrFail(params.todo)
    await auth.authorize(TodoPolicy, 'delete', todo)
    await this.service.delete(todo)
    if (request.wantsJson()) return null                               // 204
    return redirect().back().with('success', t('todos.deleted'))
  }
}
