import { defineRoutes } from '@cslug/http'
import { auth, ability, throttle } from '@cslug/http/middleware'
import { ApiTodoController } from '#app/controllers/api/api-todo-controller'

export default defineRoutes((r) => {
  r.get('/health/live', () => ({ ok: true }))

  r.group({ prefix: '/api/v1', middleware: [auth('token'), throttle('60/min')], as: 'api' }, (r) => {
    r.get('/todos', [ApiTodoController, 'index']).middleware(ability('todos:read')).name('todos.index')
    r.post('/todos', [ApiTodoController, 'store']).middleware(ability('todos:write')).name('todos.store')
  })
})
