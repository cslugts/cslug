import { defineRoutes, type HttpContext } from '../../../src'

/** API routes for the stateful-API tests: what the session looks like from routes/api.ts. */
export default defineRoutes((r) => {
  r.get('/api/session', ({ session }: HttpContext) => {
    if (!session.available) return { session: false }
    const visits = (session.get<number>('visits') ?? 0) + 1
    session.put('visits', visits)
    return { session: true, visits, token: session.token() }
  })
  r.post('/api/todos', () => ({ created: true }))
})
