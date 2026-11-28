import { afterEach, describe, expect, test } from 'bun:test'
import { AppError, type Application, ForbiddenError } from '@cslug/core'
import { vueApp } from './support'

let app: Application | undefined
afterEach(async () => {
  await app?.shutdown()
  app = undefined
})

const html = { headers: { accept: 'text/html' } }
const routes = (r: Parameters<Parameters<typeof vueApp>[0] & object>[0]) => {
  r.get('/boom', () => {
    throw new Error('db down')
  })
  r.get('/teapot', () => {
    throw new AppError('teapot', "I'm a teapot", { status: 418 })
  })
  r.get('/forbidden', () => {
    throw new ForbiddenError()
  })
}

describe('error views by convention (guide 08)', () => {
  test('errors/<status>.vue, else 4xx.vue / 5xx.vue; the status is kept; only declared props are passed', async () => {
    const h = await vueApp(routes)
    app = h.app
    const missing = await h.call('/nowhere', html)
    expect(missing.status).toBe(404)
    const body = await missing.text()
    expect(body).toContain('<h1>Lost? (404)</h1>')
    expect(body).toContain(missing.headers.get('x-request-id') as string)
    expect(body).not.toContain('code=') // undeclared props are not rendered as attributes

    const teapot = await h.call('/teapot', html)
    expect([teapot.status, await teapot.text()]).toEqual([418, expect.stringContaining('Client error 418 (teapot)')])

    const boom = await h.call('/boom', html)
    expect(boom.status).toBe(500)
    expect(await boom.text()).toContain('<pre>db down</pre>') // development: the detail
  })

  test('in production a 5xx page gets no detail', async () => {
    const h = await vueApp(routes, { app: { env: 'production', key: 'k'.repeat(32), url: 'https://example.test' } })
    app = h.app
    const body = await (await h.call('/boom', html)).text()
    expect(body).toContain('Our fault (500)')
    expect(body).not.toContain('db down')
  })

  test('API clients still get problem+json', async () => {
    const h = await vueApp(routes)
    app = h.app
    const res = await h.call('/nowhere', { headers: { accept: 'application/json' } })
    expect(res.headers.get('content-type')).toContain('application/problem+json')
  })

  test('an error view that throws falls back to the default page', async () => {
    const h = await vueApp(routes)
    app = h.app
    const res = await h.call('/forbidden', html)
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('<h1>403</h1>')
  })
})
