import { defineRoutes } from '@cslug/http'
import { throttle } from '@cslug/http/middleware'

export default defineRoutes((r) => {
  // /health/live and /health/ready come from HttpProvider
  r.group({ prefix: '/api/v1', middleware: [throttle('60/min')], as: 'api' }, (r) => {
    r.get('/hello', () => ({ message: 'Hello from {{title}}' })).name('hello')
  })
})
