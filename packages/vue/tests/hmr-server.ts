/**
 * The dev server the HMR test runs in a child process (Bun.build cannot run twice inside `bun test`): the fixture
 * copy at argv[2], as `cslug dev` starts it (CSLUG_DEV=1, CSLUG_HMR from the environment). Prints the port.
 */
import { Application, Logger } from '@cslug/core'
import { HttpKernel, HttpProvider, Router } from '@cslug/http'
import { csrf, session } from '@cslug/http/middleware'
import { VueProvider, view } from '../src'

const root = process.argv[2] as string
const app = new Application({
  root,
  configs: {
    app: { env: 'local', key: 'k'.repeat(32), url: 'http://127.0.0.1' },
    i18n: { locales: ['en', 'fr'], default: 'en' },
  },
})
app.useProviders([VueProvider, HttpProvider])
// stderr: the test shows it when a step times out
app.singleton(Logger, () => new Logger({ targets: [{ type: 'stderr' }] }))
await app.start()
const page = async (name: string) => (await import(`${root}/resources/views/${name}.vue`)).default
const Islands = await page('islands-page')
const Plain = await page('plain')
app.resolve(Router).load((r) => {
  r.group({ middleware: [session(), csrf()] }, (r) => {
    r.get('/islands', () =>
      view(Islands, { day: { id: 'd1', title: 'Tana', date: '2027-05-14', priceMinor: '12000' } }),
    )
    r.get('/plain', () => view(Plain))
    r.post('/echo', async ({ request }) => ({ message: `${(await request.body()).message} back` })).name('echo')
  })
})
const server = app.resolve(HttpKernel).listen({ port: 0, hostname: '127.0.0.1' })
console.log(`PORT ${server.port}`)
