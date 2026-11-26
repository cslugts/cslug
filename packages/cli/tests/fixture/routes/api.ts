import { defineRoutes } from '@cslug/http'
import { v } from '@cslug/validation'

const StoreTodo = v.object({ title: v.string().trim().min(1), priority: v.enum(['low', 'high']) })

export default defineRoutes((r) => {
  r.get('/api/slow', async ({ request }) => {
    await Bun.sleep(Number(request.query('ms') ?? 500))
    return { done: true }
  }).name('slow')
  r.post('/api/todos', async ({ request }) => request.validate(StoreTodo)).name('todos.store')
})
