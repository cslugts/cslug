import { auth, guest } from '@cslug/auth'
import { defineRoutes } from '@cslug/http'
import { throttle } from '@cslug/http/middleware'
import { RegisterController } from '#app/controllers/auth/register-controller'
import { SessionController } from '#app/controllers/auth/session-controller'
import { HomeController } from '#app/controllers/home-controller'

export default defineRoutes((r) => {
  r.get('/', [HomeController, 'index']).name('home')

  r.group({ middleware: [guest()] }, (r) => {
    r.get('/register', [RegisterController, 'create']).name('register')
    r.post('/register', [RegisterController, 'store']).middleware(throttle('5/min')).name('register.store')
    r.get('/login', [SessionController, 'create']).name('login')
    r.post('/login', [SessionController, 'store']).middleware(throttle('5/min')).name('login.store')
  })

  r.group({ middleware: [auth()] }, (r) => {
    r.get('/dashboard', [HomeController, 'dashboard']).name('dashboard')
    r.post('/logout', [SessionController, 'destroy']).name('logout')
  })
})
