import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Application } from '@cslug/core'
import { HttpKernel } from '@cslug/http'
import { csrf, session } from '@cslug/http/middleware'
import { view } from '../src'
import { build, FIXTURE, load, vueApp } from './support'

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')

/** Load a page in headless Chrome; the DOM after JS ran, and the console. */
async function inChrome(url: string) {
  const profile = mkdtempSync(join(tmpdir(), 'cslug-chrome-'))
  const proc = Bun.spawn(
    [
      chrome as string,
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      `--user-data-dir=${profile}`,
      '--enable-logging=stderr',
      '--v=0',
      '--virtual-time-budget=5000',
      '--dump-dom',
      url,
    ],
    { stdout: 'pipe', stderr: 'pipe', timeout: 60_000 },
  )
  const [dom, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  rmSync(profile, { recursive: true, force: true })
  return { dom, console: err.split('\n').filter((l) => l.includes('CONSOLE')) }
}

describe.skipIf(!chrome)('islands in a real browser (Chrome headless)', () => {
  let app: Application | undefined
  let base = ''
  beforeAll(async () => {
    await build({ dev: true })
    const Page = await load('views/islands-page')
    const h = await vueApp((r) => {
      r.group({ middleware: [session(), csrf()] }, (r) => {
        r.get('/islands', () =>
          view(Page, { day: { id: 'd1', title: 'Tana', date: '2027-05-14', priceMinor: '12000' } }),
        )
        r.post('/echo', async ({ request }) => ({ message: `${(await request.body()).message} back` })).name('echo')
      })
    })
    app = h.app
    const server = h.app.resolve(HttpKernel).listen({ port: 0, hostname: '127.0.0.1' })
    base = `http://127.0.0.1:${server.port}`
  })
  afterAll(async () => {
    await app?.shutdown()
    rmSync(join(FIXTURE, 'public/build'), { recursive: true, force: true })
  })

  test('islands hydrate, run onMounted, translate in the browser, and post with useForm + CSRF', async () => {
    const { dom, console: lines } = await inChrome(`${base}/islands`)
    // the counter island hydrated (onMounted ran: 1 → 2), translated with the island's namespace in the browser
    expect(dom).toMatch(/<cslug-island data-island="components\/counter"[^>]*data-mounted="true"/)
    expect(dom).toContain('data-count="2"')
    expect(dom).toContain('<span class="label">2 clicks</span>')
    // useForm posted JSON to route('echo') with the CSRF token from <meta> (csrf() would 419 otherwise)
    expect(dom).toContain('<output class="echo">hello back</output>')
    // the idle island hydrated too
    expect(dom).toMatch(/data-island="components\/day-card"[^>]*data-mounted="true"/)
    // only the declared namespaces reach the page
    expect(dom).toContain('"counter.label"')
    expect(dom).not.toContain('not sent')
    expect(lines.filter((l) => /hydration|error|warn/i.test(l))).toEqual([])
  }, 60_000)
})
