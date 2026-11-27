import { afterEach, describe, expect, test } from 'bun:test'
import { type Application, Translator, t } from '@cslug/core'
import { v } from '@cslug/validation'
import { type HttpContext, redirect } from '../src'
import { csrf, locale, session, throttle } from '../src/middleware'
import { httpApp } from './support'

let app: Application | undefined
afterEach(async () => {
  await app?.shutdown()
  app = undefined
})

/** A tiny browser: keeps cookies between requests. */
function browser(call: (path: string, init?: RequestInit) => Promise<Response>) {
  const jar = new Map<string, string>()
  return async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    const res = await call(path, { ...init, headers })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const [k, ...rest] = (pair ?? '').split('=')
      if (k) jar.set(k, rest.join('='))
    }
    return res
  }
}

const TodoValidator = v.object({ title: v.string().trim().min(1), priority: v.enum(['low', 'high']) })

const routes = (r: Parameters<Parameters<typeof httpApp>[0]>[0]) => {
  r.group({ middleware: [session(), csrf()] }, (r) => {
    r.get('/form', ({ session }: HttpContext) => ({
      token: session.token(),
      errors: session.errors(),
      old: session.old(),
      flash: session.flashed(),
    }))
    r.post('/todos', async ({ request }) => {
      await request.validate(TodoValidator)
      return redirect().to('/form').with('success', 'Todo added.')
    })
    r.put('/todos/:id', ({ params }) => ({ updated: params.id }))
    r.post('/login', ({ session }) => {
      session.regenerate()
      session.put('userId', 'u1')
      return redirect().intended('/dashboard')
    })
    r.get('/admin', ({ session }) => {
      session.put('url.intended', '/admin')
      return redirect().to('/login-page')
    })
    r.post('/logout', ({ session }) => {
      session.invalidate()
      return redirect().to('/')
    })
    r.get('/me', ({ session }) => ({ userId: session.get('userId') ?? null }))
  })
  r.post('/api/login', () => 'ok').middleware(throttle('2/min'))
  r.get('/:locale/hello', () => ({ text: t('hello') })).middleware(locale())
  r.get('/hello', ({ locale: l }) => ({ locale: l, text: t('hello') })).middleware(locale())
}
const form = (fields: Record<string, string>, token?: string) => ({
  method: 'POST',
  headers: { referer: 'http://example.test/form', accept: 'text/html' },
  body: new URLSearchParams({ ...fields, ...(token ? { _token: token } : {}) }),
})

describe('sessions, CSRF, flash, old input (guide 08 forms without JavaScript)', () => {
  test('a failed form post redirects back with errors and old input; the next page reads them once', async () => {
    const h = await httpApp(routes)
    app = h.app
    const b = browser(h.call)
    const { token } = await (await b('/form')).json()
    const res = await b('/todos', form({ title: '', priority: 'urgent', password: 'secret' }, token))
    expect([res.status, res.headers.get('location')]).toEqual([303, 'http://example.test/form'])
    const page = await (await b('/form')).json()
    expect(page.errors).toEqual({ title: ['Must be at least 1 characters.'], priority: ['Must be one of: low, high.'] })
    expect(page.old).toEqual({ title: '', priority: 'urgent' }) // no password, no _token
    expect((await (await b('/form')).json()).errors).toEqual({}) // flash lasts one request
  })

  test('success: redirect().with() flashes for the next request', async () => {
    const h = await httpApp(routes)
    app = h.app
    const b = browser(h.call)
    const { token } = await (await b('/form')).json()
    const res = await b('/todos', form({ title: 'Buy bread', priority: 'low' }, token))
    expect([res.status, res.headers.get('location')]).toEqual([303, '/form'])
    expect((await (await b('/form')).json()).flash).toEqual({ success: 'Todo added.' })
  })

  test('from useForm / http (X-Cslug-Request): redirect() answers 204 + X-Cslug-Redirect, flashes kept; 422 as JSON', async () => {
    const h = await httpApp(routes)
    app = h.app
    const b = browser(h.call)
    const { token } = await (await b('/form')).json()
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-cslug-request': '1',
      'x-csrf-token': token,
    }
    const ok = await b('/todos', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Buy bread', priority: 'low' }),
    })
    expect([ok.status, ok.headers.get('x-cslug-redirect'), ok.headers.get('location')]).toEqual([204, '/form', null])
    expect((await (await b('/form')).json()).flash).toEqual({ success: 'Todo added.' })
    const bad = await b('/todos', { method: 'POST', headers, body: JSON.stringify({ title: '', priority: 'x' }) })
    expect(bad.status).toBe(422)
    expect(Object.keys((await bad.json()).errors).sort()).toEqual(['priority', 'title'])
  })

  test('CSRF: missing or wrong token → 419; header X-CSRF-Token also accepted; JSON clients get problem+json', async () => {
    const h = await httpApp(routes)
    app = h.app
    const b = browser(h.call)
    const { token } = await (await b('/form')).json()
    expect((await b('/todos', form({ title: 'x', priority: 'low' }))).status).toBe(419)
    expect((await b('/todos', form({ title: 'x', priority: 'low' }, 'forged'))).status).toBe(419)
    const json = await b('/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ title: '', priority: 'low' }),
    })
    expect([json.status, (await json.json()).errors]).toEqual([422, { title: ['Must be at least 1 characters.'] }])
  })

  test('method spoofing: a POST form with _method=PUT reaches the PUT route', async () => {
    const h = await httpApp(routes)
    app = h.app
    const b = browser(h.call)
    const { token } = await (await b('/form')).json()
    const res = await b('/todos/t1', form({ _method: 'PUT' }, token))
    expect(await res.json()).toEqual({ updated: 't1' })
  })

  test('login regenerates the id (no fixation), intended URL, logout invalidates', async () => {
    const h = await httpApp(routes)
    app = h.app
    const b = browser(h.call)
    const first = await b('/form')
    const before = first.headers.getSetCookie()[0]
    const { token } = await first.json()
    await b('/admin') // a guest asking for /admin is sent to login, remembering where to go
    const login = await b('/login', form({}, token))
    expect(login.headers.get('location')).toBe('/admin')
    expect(login.headers.getSetCookie()[0]?.split(';')[0]).not.toBe(before?.split(';')[0])
    expect(await (await b('/me')).json()).toEqual({ userId: 'u1' })
    const { token: t2 } = await (await b('/form')).json()
    await b('/logout', form({}, t2))
    expect(await (await b('/me')).json()).toEqual({ userId: null })
  })

  test('the session cookie is HttpOnly and SameSite=Lax', async () => {
    const h = await httpApp(routes)
    app = h.app
    const cookie = (await h.call('/form')).headers.getSetCookie()[0] ?? ''
    expect(cookie).toMatch(/^cslug_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=1209600$/)
  })

  test('without the session middleware, session use explains itself', async () => {
    const h = await httpApp((r) => {
      r.get('/x', ({ session }) => session.get('a'))
    })
    app = h.app
    expect((await (await h.call('/x')).json()).detail).toContain('add the session() middleware')
  })
})

describe('throttle and locale', () => {
  test('throttle: headers, then 429 with Retry-After', async () => {
    const h = await httpApp(routes)
    app = h.app
    const hit = () => h.call('/api/login', { method: 'POST' })
    const r1 = await hit()
    expect([r1.status, r1.headers.get('x-ratelimit-limit'), r1.headers.get('x-ratelimit-remaining')]).toEqual([
      200,
      '2',
      '1',
    ])
    await hit()
    const r3 = await hit()
    expect(r3.status).toBe(429)
    expect(Number(r3.headers.get('retry-after'))).toBeGreaterThan(50)
  })

  test('locale: route parameter, cookie, Accept-Language, default; t() follows it', async () => {
    const h = await httpApp(routes, { i18n: { locales: ['fr', 'en', 'it'], default: 'en' } })
    app = h.app
    h.app.resolve(Translator).add('fr', { hello: 'Bonjour' }).add('en', { hello: 'Hello' }).add('it', { hello: 'Ciao' })
    expect(await (await h.call('/fr/hello')).json()).toEqual({ text: 'Bonjour' })
    expect(await (await h.call('/de/hello')).json()).toEqual({ text: 'Hello' }) // unsupported → default
    expect(await (await h.call('/hello', { headers: { cookie: 'locale=it' } })).json()).toEqual({
      locale: 'it',
      text: 'Ciao',
    })
    expect(
      await (await h.call('/hello', { headers: { 'accept-language': 'de-DE,fr-FR;q=0.8,en;q=0.5' } })).json(),
    ).toEqual({ locale: 'fr', text: 'Bonjour' })
    expect((await (await h.call('/hello')).json()).locale).toBe('en')
  })
})
