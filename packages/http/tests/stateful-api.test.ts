import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Application, Logger } from '@cslug/core'
import { HttpKernel, HttpProvider } from '../src'
import { fromFrontEnd } from '../src/middleware'

const ROOT = join(import.meta.dir, 'fixture-api')
let app: Application | undefined
afterEach(async () => {
  await app?.shutdown()
  app = undefined
})

/** The app with routes/api.ts loaded by HttpProvider (the api group), and a client keeping cookies. */
async function apiApp(http: Record<string, unknown>) {
  app = new Application({
    root: ROOT,
    configs: { app: { url: 'https://example.test', key: 'k'.repeat(32), env: 'test' }, http },
  }).useProviders([HttpProvider])
  app.singleton(Logger, () => Logger.null())
  await app.start()
  const kernel = app.resolve(HttpKernel).compile()
  const jar = new Map<string, string>()
  return async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    const res = await kernel.handle(new Request(new URL(path, 'https://example.test'), { ...init, headers }))
    for (const c of res.headers.getSetCookie()) {
      const [k, ...rest] = (c.split(';')[0] ?? '').split('=')
      if (k) jar.set(k, rest.join('='))
    }
    return res
  }
}
const ORIGIN = { origin: 'https://example.test', accept: 'application/json' }

test('fromFrontEnd: Origin, else Referer, else Sec-Fetch-Site', () => {
  const h = (headers: Record<string, string>) => ({ header: (n: string) => headers[n] })
  const origins = ['https://example.test']
  expect(fromFrontEnd(h({ origin: 'https://example.test' }), origins)).toBe(true)
  expect(fromFrontEnd(h({ origin: 'https://evil.test' }), origins)).toBe(false)
  expect(fromFrontEnd(h({ referer: 'https://example.test/trips?x=1' }), origins)).toBe(true)
  expect(fromFrontEnd(h({ referer: 'not a url' }), origins)).toBe(false)
  expect(fromFrontEnd(h({ 'sec-fetch-site': 'same-origin' }), origins)).toBe(true)
  expect(fromFrontEnd(h({ 'sec-fetch-site': 'cross-site' }), origins)).toBe(false)
  expect(fromFrontEnd(h({}), origins)).toBe(false) // curl, servers: token clients
})

describe('http.api.stateful', () => {
  test("the app's own pages get the session and CSRF on routes/api.ts", async () => {
    const call = await apiApp({ api: { stateful: true } })
    const first = await (await call('/api/session', { headers: ORIGIN })).json()
    expect(first).toMatchObject({ session: true, visits: 1 })
    expect((await (await call('/api/session', { headers: ORIGIN })).json()).visits).toBe(2) // the same session
    expect((await call('/api/todos', { method: 'POST', headers: ORIGIN })).status).toBe(419) // no CSRF token
    const ok = await call('/api/todos', { method: 'POST', headers: { ...ORIGIN, 'x-csrf-token': first.token } })
    expect(await ok.json()).toEqual({ created: true })
    expect((await (await call('/api/session', { headers: { 'sec-fetch-site': 'same-origin' } })).json()).session).toBe(
      true,
    )
  })

  test('other origins and non-browser clients: no session, no CSRF (API tokens)', async () => {
    const call = await apiApp({ api: { stateful: true } })
    expect(await (await call('/api/session', { headers: { origin: 'https://evil.test' } })).json()).toEqual({
      session: false,
    })
    const res = await call('/api/session')
    expect(await res.json()).toEqual({ session: false })
    expect(res.headers.getSetCookie()).toEqual([])
    expect((await call('/api/todos', { method: 'POST' })).status).toBe(200)
  })

  test('off by default; a list of origins (another front end)', async () => {
    const off = await apiApp({})
    expect(await (await off('/api/session', { headers: ORIGIN })).json()).toEqual({ session: false })
    await app?.shutdown()
    const listed = await apiApp({ api: { stateful: ['https://app.example.test'] } })
    expect(
      (await (await listed('/api/session', { headers: { origin: 'https://app.example.test' } })).json()).session,
    ).toBe(true)
    expect((await (await listed('/api/session', { headers: ORIGIN })).json()).session).toBe(false)
  })
})
