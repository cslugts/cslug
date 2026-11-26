import { Application, Logger, type ProviderClass } from '@cslug/core'
import { HttpKernel, HttpProvider, type RouteRegistrar, Router } from '../src'

/** An app with HttpProvider booted and these routes loaded (no route files, no port). */
export async function httpApp(
  routes: (r: RouteRegistrar) => void,
  configs: Record<string, unknown> = {},
  providers: ProviderClass[] = [],
) {
  const app = new Application({
    root: '/nonexistent-cslug-test-root',
    configs: { app: { url: 'https://albastr.test', key: 'k'.repeat(32), env: 'test' }, ...configs },
  })
  app.useProviders([HttpProvider, ...providers])
  app.singleton(Logger, () => Logger.null()) // tests assert on responses; keep the output clean
  await app.start()
  app.resolve(Router).load(routes)
  const kernel = app.resolve(HttpKernel).compile()
  const call = (path: string, init: RequestInit & { host?: string } = {}) => {
    const url = new URL(path, `http://${init.host ?? 'albastr.test'}`)
    return kernel.handle(new Request(url, init))
  }
  return { app, kernel, call }
}
