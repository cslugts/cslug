import { defineRoutes } from '@cslug/http'
import { throttle } from '@cslug/http/middleware'
import { ability, auth } from '@cslug/auth'
import { ApiTodoController } from '#app/controllers/api/api-todo-controller'

export default defineRoutes((r) => {
  // /health/live and /health/ready come from HttpProvider
  r.group({ prefix: '/api/v1', middleware: [auth('token'), throttle('60/min')], as: 'api' }, (r) => {
    r.get('/todos', [ApiTodoController, 'index']).middleware(ability('todos:read')).name('todos.index')
    r.post('/todos', [ApiTodoController, 'store']).middleware(ability('todos:write')).name('todos.store')
  })
})
