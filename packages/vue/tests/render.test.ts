import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type { Application } from '@cslug/core'
import { Translator } from '@cslug/core'
import { redirect } from '@cslug/http'
import { session } from '@cslug/http/middleware'
import { v } from '@cslug/validation'
import { renderPage, renderStandalone, serialize, view } from '../src'
import { FIXTURE, load, vueApp } from './support'

let app: Application | undefined
afterEach(async () => {
  await app?.shutdown()
  app = undefined
  rmSync(`${FIXTURE}/public/build`, { recursive: true, force: true })
})
const days = [
  { id: 'd1', title: 'Tana', date: new Date('2027-05-14T08:00:00Z'), priceMinor: 12000n },
  { id: 'd2', title: 'Isalo', date: new Date('2027-05-15T08:00:00Z'), priceMinor: 9000n },
]

describe('server rendering (guide 08)', () => {
  test('a page with a layout: doctype, translations, static components, one island with serialized props', async () => {
    const h = await vueApp()
    app = h.app
    h.app
      .resolve(Translator)
      .add('fr', { days: { title: 'Itinéraire', count: '{count, plural, one {# jour} other {# jours}}' } })
    const { html, state } = await renderPage(await load('views/itinerary'), { days })
    expect(html.startsWith('<!doctype html><html lang="en">')).toBe(true)
    expect(html).toContain('<h1>Itinerary · 2 days</h1>')
    // two static day cards (no marker) + one island
    expect(html.match(/class="day-card"/g)?.length).toBe(3)
    expect([...state.islands]).toEqual(['components/day-card'])
    const marker = /<cslug-island data-island="components\/day-card" data-hydrate="visible" data-props="([^"]+)">/.exec(
      html,
    )
    expect(JSON.parse((marker?.[1] ?? '').replace(/&quot;/g, '"'))).toEqual({
      day: { id: 'd1', title: 'Tana', date: '2027-05-14T08:00:00.000Z', priceMinor: '12000' },
    })
    // the island's HTML is rendered from the serialized props, as the browser will
    expect(html).toMatch(
      /<cslug-island[^>]*><li class="day-card" data-v-\w+><strong data-v-\w+>Tana<\/strong> <time data-v-\w+>2027-05-14T08:00:00.000Z<\/time>/,
    )
    // hydrate="none": plain HTML; :ssr="false" not rendered here (withMap false)
    expect(html).toContain('<div class="map">map 1,2</div>')
    expect(html).not.toContain('data-island="components/map-widget"')
    // CSS of rendered components, scoped, in the head; no script without a build
    expect(html).toMatch(/<style data-cslug>[^<]*\.day-card\[data-v-/)
    expect(html).not.toContain('<script')
  })

  test(':ssr="false" renders the #fallback inside the island marker', async () => {
    const h = await vueApp()
    app = h.app
    const { html } = await renderPage(await load('views/itinerary'), { days, withMap: true })
    expect(html).toMatch(
      /<cslug-island data-island="components\/map-widget" data-hydrate="load" data-props="[^"]+" data-ssr="false"><!--\[--><p class="loading">Loading map…<\/p><!--\]--><\/cslug-island>/,
    )
  })

  test('<Assets> with a build manifest: entry CSS, island chunks preloaded, the client script only with islands', async () => {
    const h = await vueApp()
    app = h.app
    mkdirSync(`${FIXTURE}/public/build`, { recursive: true })
    writeFileSync(
      `${FIXTURE}/public/build/manifest.json`,
      JSON.stringify({
        entries: { client: { js: '/build/client-ab12.js', css: ['/build/client-cd34.css'] } },
        islands: { 'components/day-card': '/build/day-card-ef56.js' },
      }),
    )
    const withIslands = (await renderPage(await load('views/itinerary'), { days })).html
    expect(withIslands).toContain('<link rel="stylesheet" href="/build/client-cd34.css">')
    expect(withIslands).toContain('<link rel="modulepreload" href="/build/day-card-ef56.js">')
    expect(withIslands).toContain('<script type="module" src="/build/client-ab12.js"></script>')
    const without = (await renderPage(await load('views/itinerary'), { days: [] })).html
    expect(without).toContain('/build/client-cd34.css') // CSS always
    expect(without).not.toContain('<script') // no islands → no JS
  })

  test('a page without layout or <Assets> still gets its CSS', async () => {
    const h = await vueApp()
    app = h.app
    const { html } = await renderPage(await load('views/plain'))
    expect(html).toBe('<style data-cslug>\n.plain { margin: 0;\n}\n</style><p class="plain">No layout, no islands.</p>')
  })

  test('renderStandalone: one file, no scripts, CSS and images inlined, islands as plain HTML', async () => {
    const h = await vueApp()
    app = h.app
    mkdirSync(`${FIXTURE}/public/build`, { recursive: true })
    writeFileSync(`${FIXTURE}/public/build/client.css`, 'body{font-family:serif}')
    writeFileSync(
      `${FIXTURE}/public/build/manifest.json`,
      JSON.stringify({ entries: { client: { js: '/build/c.js', css: ['/build/client.css'] } }, islands: {} }),
    )
    const html = await renderStandalone(await load('views/itinerary'), { days })
    expect(html).not.toContain('<script')
    expect(html).not.toContain('cslug-island')
    expect(html).toContain('<style>body{font-family:serif}</style>')
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="')
  })
})

describe('view() in a request', () => {
  const LoginValidator = v.object({ email: v.string().email() })

  test('useRequest: CSRF token, errors and old input after a failed form post, flash; status and headers', async () => {
    const Login = await load('views/login')
    const h = await vueApp((r) => {
      r.group({ middleware: [session()] }, (r) => {
        r.get('/login', () => view(Login, {}, { headers: { 'x-page': 'login' } }))
        r.post('/login', async ({ request }) => {
          await request.validate(LoginValidator)
          return redirect().to('/login').with('success', 'Welcome')
        })
        r.get('/missing', () => view(Login, {}, { status: 404 }))
      })
    })
    app = h.app
    const first = await h.call('/login')
    expect([first.status, first.headers.get('content-type'), first.headers.get('x-page')]).toEqual([
      200,
      'text/html; charset=utf-8',
      'login',
    ])
    const cookie = first.headers.getSetCookie()[0]?.split(';')[0] ?? ''
    const page = await first.text()
    const token = /name="_token" value="([^"]+)"/.exec(page)?.[1]
    expect(page).toContain(`<meta name="csrf-token" content="${token}">`)

    const post = await h.call('/login', {
      method: 'POST',
      headers: { cookie, referer: 'https://example.test/login', 'content-type': 'application/x-www-form-urlencoded' },
      body: `_token=${token}&email=nope`,
    })
    expect(post.status).toBe(303)
    const again = await (await h.call('/login', { headers: { cookie } })).text()
    expect(again).toContain('<input name="email" value="nope">')
    expect(again).toMatch(/<p class="error">.+email.+<\/p>/i)
    expect((await h.call('/missing', { headers: { cookie } })).status).toBe(404)
  })

  test('locale from the route; alternates for each locale', async () => {
    const Itinerary = await load('views/itinerary')
    const h = await vueApp((r) => {
      r.get('/:locale/itinerary', () => view(Itinerary, { days })).name('itinerary')
    })
    app = h.app
    const { locale } = await import('@cslug/http/middleware')
    h.app
      .resolve(Translator)
      .add('fr', { days: { title: 'Itinéraire', count: '{count, plural, one {# jour} other {# jours}}' } })
    const h2 = await vueApp((r) => {
      r.get('/:locale/itinerary', () => view(Itinerary, { days }))
        .name('itinerary')
        .middleware(locale())
    })
    await h.app.shutdown()
    app = h2.app
    h2.app
      .resolve(Translator)
      .add('fr', { days: { title: 'Itinéraire', count: '{count, plural, one {# jour} other {# jours}}' } })
    const html = await (await h2.call('/fr/itinerary?ref=x')).text()
    expect(html).toContain('<html lang="fr">')
    expect(html).toContain('<h1>Itinéraire · 2 jours</h1>')
    expect(html).toContain('<link rel="alternate" hreflang="en" href="https://example.test/en/itinerary?ref=x">')
    expect(html).toContain('<link rel="alternate" hreflang="fr" href="https://example.test/fr/itinerary?ref=x">')
  })
})

describe('serialize()', () => {
  test('bigint and Date as JSON delivers them; problems reported', () => {
    expect(serialize({ a: 1n, d: new Date('2027-01-01T00:00:00Z'), n: null })).toEqual({
      a: '1',
      d: '2027-01-01T00:00:00.000Z',
      n: null,
    })
    const problems: string[] = []
    class Thing {
      x = 1
    }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    serialize({ f: () => 1, t: new Thing() }, (p) => problems.push(p))
    expect(problems).toEqual(['f is a function (dropped)', 't is a Thing instance (only its fields reach the browser)'])
    expect(() => serialize(cyclic, (p) => problems.push(p))).toThrow()
    expect(problems.at(-1)).toBe('self is circular')
  })
})
