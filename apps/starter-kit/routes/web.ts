import { defineRoutes } from '@cslug/http'
import { throttle } from '@cslug/http/middleware'
import { auth, guest } from '@cslug/auth'
import { HomeController } from '#app/controllers/home-controller'
import { RegisterController } from '#app/controllers/auth/register-controller'
import { SessionController } from '#app/controllers/auth/session-controller'
import { TodoController } from '#app/controllers/todo-controller'

export default defineRoutes((r) => {
  r.get('/', [HomeController, 'index']).name('home')

  r.group({ middleware: [guest()] }, (r) => {
    r.get('/register', [RegisterController, 'create']).name('register')
    r.post('/register', [RegisterController, 'store']).middleware(throttle('5/min')).name('register.store')
    r.get('/login', [SessionController, 'create']).name('login')
    r.post('/login', [SessionController, 'store']).middleware(throttle('5/min')).name('login.store')
  })

  r.group({ middleware: [auth()] }, (r) => {
    r.post('/logout', [SessionController, 'destroy']).name('logout')

    r.group({ prefix: '/todos', as: 'todos' }, (r) => {
      r.get('/', [TodoController, 'index']).name('index')
      r.post('/', [TodoController, 'store']).name('store')
      r.patch('/:todo', [TodoController, 'update']).name('update')
      r.post('/:todo/toggle', [TodoController, 'toggle']).name('toggle')
      r.delete('/:todo', [TodoController, 'destroy']).name('destroy')
    })
  })
})
