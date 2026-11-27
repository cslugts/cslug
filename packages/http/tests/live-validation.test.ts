import { afterEach, expect, test } from 'bun:test'
import type { Application } from '@cslug/core'
import { v } from '@cslug/validation'
import type { HttpContext, MiddlewareFn } from '../src'
import { httpApp } from './support'

let app: Application | undefined
afterEach(async () => {
  await app?.shutdown()
  app = undefined
})

const StoreUser = v.object({
  email: v.email(),
  name: v.string().min(2),
  address: v.object({ city: v.string().min(1) }),
})

test('X-Cslug-Validate: middleware and the declared schema run, the handler never; errors only for the asked fields', async () => {
  const handled: unknown[] = []
  const seen: string[] = []
  const tracking: MiddlewareFn = (_ctx, next) => {
    seen.push('middleware')
    return next()
  }
  const h = await httpApp((r) => {
    r.post('/users', async ({ request }: HttpContext) => {
      handled.push(await request.validate(StoreUser))
      return { created: true }
    })
      .middleware(tracking)
      .validates(StoreUser)
    r.post('/plain', () => ({ ok: true }))
  })
  app = h.app
  const live = (fields: string, body: unknown, path = '/users') =>
    h.call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-cslug-validate': fields },
      body: JSON.stringify(body),
    })

  const bad = { email: 'nope', name: 'A', address: { city: '' } }
  const onlyEmail = await live('email', bad)
  expect(onlyEmail.status).toBe(422)
  expect(Object.keys((await onlyEmail.json()).errors)).toEqual(['email'])
  const nested = await live('email,address', bad)
  expect(Object.keys((await nested.json()).errors).sort()).toEqual(['address.city', 'email'])
  expect(Object.keys((await (await live('*', bad)).json()).errors).sort()).toEqual(['address.city', 'email', 'name'])

  const valid = await live('email', { email: 'ada@example.test', name: 'A' }) // other fields' errors don't count
  expect([valid.status, valid.headers.get('x-cslug-validated')]).toEqual([204, '1'])
  expect(handled).toEqual([]) // never ran
  expect(seen).toEqual(['middleware', 'middleware', 'middleware', 'middleware'])

  const refused = await live('email', bad, '/plain')
  expect(refused.status).toBe(400)
  expect(await refused.json()).toMatchObject({
    code: 'http.no_live_validation',
    title: 'POST /plain does not support live validation: declare .validates(schema) on the route',
  })

  const real = await h.call('/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email: 'ada@example.test', name: 'Ada', address: { city: 'Tana' } }),
  })
  expect(await real.json()).toEqual({ created: true }) // without the header: the handler as usual
})
