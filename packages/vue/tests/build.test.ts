import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Application } from '@cslug/core'
import { buildAssets, findIslands } from '../src/build-entry'
import { FIXTURE, vueApp } from './support'

const OUT = join(FIXTURE, 'public/build')

describe('the asset build (guide 08 § asset pipeline)', () => {
  afterAll(() => rmSync(OUT, { recursive: true, force: true }))

  test('findIslands: every component used with hydrate anywhere, resolved through imports', () => {
    expect(findIslands(FIXTURE).map((f) => f.slice(FIXTURE.length + 1))).toEqual([
      'resources/components/counter.vue',
      'resources/components/day-card.vue',
      'resources/components/map-widget.vue',
    ])
  })

  test('production: hashed entry + CSS, one chunk per island, Vue shared, browser-only code', async () => {
    const { manifest } = await buildAssets({ root: FIXTURE })
    expect(manifest.entries.client?.js).toMatch(/^\/build\/resources\/client-[a-z0-9]{8}\.js$/)
    expect(manifest.entries.client?.css).toEqual([
      expect.stringMatching(/^\/build\/resources\/client-[a-z0-9]{8}\.css$/),
    ])
    expect(Object.keys(manifest.islands).sort()).toEqual([
      'components/counter',
      'components/day-card',
      'components/map-widget',
    ])
    expect(JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'))).toEqual(manifest)

    const css = readFileSync(join(FIXTURE, 'public', manifest.entries.client?.css?.[0] ?? ''), 'utf8')
    expect(css).toMatch(/body\s*\{\s*color:\s*#0f766e/)
    const client = readFileSync(join(FIXTURE, 'public', manifest.entries.client?.js ?? ''), 'utf8')
    // the browser entry of @cslug/vue: no server renderer, no Node APIs, no server-side core
    for (const server of ['renderToString', 'node:', 'AsyncLocalStorage', 'compileScript'])
      expect(client).not.toContain(server)
    const island = readFileSync(join(FIXTURE, 'public', manifest.islands['components/counter'] ?? ''), 'utf8')
    expect(island.length).toBeLessThan(5000) // Vue is in a shared chunk, not in each island
  })

  test('dev: readable names, source maps', async () => {
    const { manifest } = await buildAssets({ root: FIXTURE, dev: true })
    expect(manifest.entries.client?.js).toBe('/build/resources/client.js')
    expect(existsSync(join(OUT, 'resources/client.js.map'))).toBe(true)
  })

  test('a missing entry is a clear error', async () => {
    await expect(buildAssets({ root: FIXTURE, entries: { admin: 'resources/admin.ts' } })).rejects.toThrow(
      'resources/admin.ts does not exist',
    )
  })
})

describe('serving the build', () => {
  let app: Application | undefined
  let call: (path: string, init?: RequestInit) => Promise<Response>
  beforeAll(async () => {
    await buildAssets({ root: FIXTURE })
    const h = await vueApp()
    app = h.app
    call = h.call
  })
  afterAll(async () => {
    await app?.shutdown()
    rmSync(OUT, { recursive: true, force: true })
  })

  test('public/ files: type, immutable caching for hashed files, 304, no traversal or dotfiles', async () => {
    const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'))
    const js = await call(manifest.entries.client.js)
    expect([js.status, js.headers.get('content-type'), js.headers.get('cache-control')]).toEqual([
      200,
      'text/javascript;charset=utf-8',
      'public, max-age=31536000, immutable',
    ])
    const img = await call('/img/dot.png')
    expect([img.status, img.headers.get('cache-control')]).toEqual([200, 'public, max-age=0, must-revalidate'])
    expect(
      (await call('/img/dot.png', { headers: { 'if-modified-since': img.headers.get('last-modified') ?? '' } })).status,
    ).toBe(304)
    expect((await call('/img/dot.png', { method: 'HEAD' })).headers.get('content-length')).toBe('8')
    expect((await call('/../package.json')).status).toBe(404)
    expect((await call('/%2e%2e/package.json')).status).toBe(404)
    expect((await call('/build/.hidden')).status).toBe(404)
  })
})
