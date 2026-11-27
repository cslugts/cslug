import { afterEach, describe, expect, test } from 'bun:test'
import { type Application, Encrypter, inject } from '@cslug/core'
import { type HttpContext, Router, route, urlFor, verifySignedUrl } from '../src'
import { signed } from '../src/middleware'
import { httpApp } from './support'

let app: Application | undefined
afterEach(async () => {
  await app?.shutdown()
  app = undefined
})

@inject()
class OperatorController {
  index() {
    return { action: 'index' }
  }
  show({ params }: HttpContext) {
    return { action: 'show', operator: params.operator }
  }
  store() {
    return { action: 'store' }
  }
  update({ params }: HttpContext) {
    return { action: 'update', operator: params.operator }
  }
  destroy() {
    return null
  }
}
@inject()
class ReleaseStageController {
  handle({ params }: HttpContext) {
    return { released: params.booking }
  }
}

const routes = (r: Parameters<Parameters<typeof httpApp>[0]>[0]) => {
  r.get('/', () => 'home').name('home')
  r.group({ prefix: '/:locale', as: 'public' }, (r) => {
    r.get('/circuits/:slug', ({ params }) => params).name('circuits.show')
    r.get('/circuits/new', () => 'static beats param').name('circuits.new')
  })
  r.resource('operators', OperatorController).only(['index', 'show', 'store', 'update', 'destroy'])
  r.post('/admin/bookings/:booking/release', ReleaseStageController).name('admin.bookings.release')
  r.group({ domain: 'api.example.test', prefix: '/v1', as: 'api' }, (r) => {
    r.get('/quotes', () => ({ api: true })).name('quotes.index')
  })
  r.group({ domain: ':operator.example.test', as: 'operator-site' }, (r) => {
    r.get('/', ({ params }) => ({ site: params.operator }))
      .name('home')
      .where('operator', /^[a-z0-9-]{3,40}$/)
  })
  r.get('/download/:file', ({ params }) => params.file)
    .name('download')
    .middleware(signed())
}

describe('routing (guide 05)', () => {
  test('groups with prefix params, names, static beats parameter', async () => {
    const h = await httpApp(routes)
    app = h.app
    expect(await (await h.call('/fr/circuits/tana-isalo')).json()).toEqual({ locale: 'fr', slug: 'tana-isalo' })
    expect(await (await h.call('/fr/circuits/new')).text()).toBe('static beats param')
    expect(await (await h.call('/')).text()).toBe('home')
    expect(await (await h.call('/fr/circuits/tana-isalo/')).json()).toEqual({ locale: 'fr', slug: 'tana-isalo' }) // trailing slash
  })

  test('resource routes and single-action controllers', async () => {
    const h = await httpApp(routes)
    app = h.app
    expect(await (await h.call('/operators')).json()).toEqual({ action: 'index' })
    expect(await (await h.call('/operators/op1')).json()).toEqual({ action: 'show', operator: 'op1' })
    expect(await (await h.call('/operators', { method: 'POST' })).json()).toEqual({ action: 'store' })
    expect(await (await h.call('/operators/op1', { method: 'PATCH' })).json()).toEqual({
      action: 'update',
      operator: 'op1',
    })
    expect((await h.call('/operators/op1', { method: 'DELETE' })).status).toBe(204)
    // create is excluded by only(), so /operators/create is the show route for an operator named "create"
    expect(await (await h.call('/operators/create')).json()).toEqual({ action: 'show', operator: 'create' })
    expect(await (await h.call('/admin/bookings/b9/release', { method: 'POST' })).json()).toEqual({ released: 'b9' })
  })

  test('domain routing: fixed host, host parameters with constraints; others fall through', async () => {
    const h = await httpApp(routes)
    app = h.app
    expect(await (await h.call('/v1/quotes', { host: 'api.example.test' })).json()).toEqual({ api: true })
    expect((await h.call('/v1/quotes')).status).toBe(404)
    expect(await (await h.call('/', { host: 'ravinala-tours.example.test' })).json()).toEqual({
      site: 'ravinala-tours',
    })
    expect(await (await h.call('/', { host: 'ab.example.test' })).text()).toBe('home') // constraint fails → the domain-less route
  })

  test('405 with Allow, HEAD falls back to GET (no body), 404 as problem+json', async () => {
    const h = await httpApp(routes)
    app = h.app
    const r405 = await h.call('/operators/op1', { method: 'PUT' })
    expect(r405.status).toBe(405)
    expect(r405.headers.get('allow')).toBe('GET, PATCH, DELETE, HEAD')
    const head = await h.call('/', { method: 'HEAD' })
    expect([head.status, await head.text()]).toEqual([200, ''])
    const r404 = await h.call('/nope', { headers: { accept: 'application/json' } })
    expect(r404.status).toBe(404)
    expect(r404.headers.get('content-type')).toContain('application/problem+json')
    expect(await r404.json()).toMatchObject({
      status: 404,
      code: 'route.not_found',
      type: 'https://example.test/errors/route.not_found',
    })
  })

  test('route(): paths, query, other domains absolute, missing params explained', async () => {
    const h = await httpApp(routes)
    app = h.app
    expect(route('public.circuits.show', { locale: 'it', slug: 'tana-isalo' })).toBe('/it/circuits/tana-isalo')
    expect(route('operators.show', { operator: 'op 1' }, { query: { tab: 'docs' } })).toBe('/operators/op%201?tab=docs')
    expect(route('home', { ref: 'x' })).toBe('/?ref=x') // unknown params become query
    expect(route('api.quotes.index')).toBe('https://api.example.test/v1/quotes')
    expect(route('operator-site.home', { operator: 'ravinala-tours' })).toBe('https://ravinala-tours.example.test/')
    expect(route('home', {}, { absolute: true })).toBe('https://example.test/')
    expect(() => route('operators.show')).toThrow('Route "operators.show" needs parameter "operator"')
    expect(() => route('nope')).toThrow('No route named "nope"')
  })

  test('signed URLs: valid, tampered, expired', async () => {
    const h = await httpApp(routes)
    app = h.app
    const url = route('download', { file: 'trip-pack.pdf' }, { signed: true, expiresIn: '30m' })
    expect(url).toMatch(/^https:\/\/example\.test\/download\/trip-pack\.pdf\?expires=\d+&signature=/)
    expect(await (await h.call(url)).text()).toBe('trip-pack.pdf')
    expect((await h.call(url.replace('trip-pack', 'other'))).status).toBe(403)
    const key = 'k'.repeat(32)
    const expired = urlFor(
      h.app.resolve(Router),
      'https://example.test',
      key,
      'download',
      { file: 'x' },
      { signed: true, expiresIn: '1s' },
    )
    expect(verifySignedUrl(expired, key, Date.now() + 5000)).toBe(false)
    expect(verifySignedUrl(expired, 'another key', Date.now())).toBe(false)

    // after a key rotation (APP_KEY new, the old one in APP_PREVIOUS_KEYS) the link still opens
    h.app.swap(Encrypter, new Encrypter('n'.repeat(32), [key]))
    expect((await h.call(url)).status).toBe(200)
    expect(route('download', { file: 'x' }, { signed: true })).not.toContain(
      urlFor(h.app.resolve(Router), 'https://example.test', key, 'download', { file: 'x' }, { signed: true }).split(
        'signature=',
      )[1],
    )
    h.app.swap(Encrypter, new Encrypter('n'.repeat(32)))
    expect((await h.call(url)).status).toBe(403) // the old key removed: the link stops working
  })

  test('duplicate route names are refused at compile', async () => {
    const h = await httpApp((r) => {
      r.get('/a', () => 1).name('x')
      r.get('/b', () => 2).name('x')
    }).catch((e: Error) => e)
    expect((h as Error).message).toBe('Two routes are named "x"')
  })
})
