import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Application, Logger } from '@cslug/core'
import { HttpKernel, HttpProvider, type RouteRegistrar, Router } from '@cslug/http'
import { registerVueLoader, VueProvider } from '../src'

export const FIXTURE = `${import.meta.dir}/fixture`
// the fixture is its own package (for `#components/*`): let it import @cslug/vue like an app would
const link = `${FIXTURE}/node_modules/@cslug/vue`
if (!existsSync(link)) {
  mkdirSync(`${FIXTURE}/node_modules/@cslug`, { recursive: true })
  symlinkSync(join(import.meta.dir, '..'), link, 'dir')
}
registerVueLoader(FIXTURE)

/** Import a fixture view or component (after the loader is registered). */
export const load = async (path: string) => (await import(`${FIXTURE}/resources/${path}.vue`)).default

/** The fixture app (Vue + HTTP), with routes, started. */
export async function vueApp(routes: (r: RouteRegistrar) => void = () => {}, configs: Record<string, unknown> = {}) {
  const app = new Application({
    root: FIXTURE,
    configs: {
      app: { env: 'test', key: 'k'.repeat(32), url: 'https://albastr.test' },
      i18n: { locales: ['en', 'fr'], default: 'en' },
      ...configs,
    },
  })
  app.useProviders([VueProvider, HttpProvider])
  app.singleton(Logger, () => Logger.null())
  await app.start()
  app.resolve(Router).load(routes)
  const kernel = app.resolve(HttpKernel)
  kernel.compile()
  const call = (path: string, init?: RequestInit) =>
    kernel.handle(new Request(`https://albastr.test${path}`, init), { ip: '127.0.0.1' })
  return { app, call }
}
