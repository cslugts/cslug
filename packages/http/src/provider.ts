import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Logger, ServiceProvider } from '@cslug/core'
import { httpCommands, routeRows } from './commands'
import { ExceptionHandler } from './errors'
import { HttpKernel } from './kernel'
import { bodyLimit, cors, csrf, securityHeaders, session } from './middleware'
import { type GroupOptions, type Middleware, type RouteRegistrar, Router } from './router'

export type HttpConfig = {
  port?: number
  host?: string
  /** Time to let in-flight requests finish on shutdown. */
  shutdownTimeout?: string | number
  bodyLimit?: string | number
  /** Folder served for GET/HEAD requests no route matches (default `public`); false turns it off. */
  public?: boolean | string
  trustedProxies?: string[]
  cors?: { origins: string[]; credentials?: boolean }
  /** Extra middleware for the `web` (routes/web.ts) and `api` (routes/api.ts) groups. */
  groups?: { web?: Middleware[]; api?: Middleware[] }
  /** Global middleware added after the defaults. */
  middleware?: Middleware[]
  /** Problem `type` URL base (default `${app.url}/errors`). */
  problemBase?: string
  /** Disable the /health endpoints. */
  health?: boolean
}

/** Tags for middleware that packages add to the `web` / `api` groups (`this.app.tag([token], WEB_MIDDLEWARE)`). */
export const WEB_MIDDLEWARE = 'http.middleware.web'
export const API_MIDDLEWARE = 'http.middleware.api'

/**
 * Binds Router, ExceptionHandler and HttpKernel; at boot loads `routes/web.ts` (web group) and `routes/api.ts`
 * (api group) when they exist; on shutdown stops the server gracefully. `cslug serve` calls `kernel.listen()`.
 */
export class HttpProvider extends ServiceProvider {
  register() {
    this.commands(httpCommands)
    this.describe('routes', () => routeRows(this.app.resolve(Router)))
    this.app.singleton(Router, () => new Router())
    this.app.singleton(ExceptionHandler, (c) => new ExceptionHandler(this.app, c.resolve(Logger)))
    this.app.singleton(
      HttpKernel,
      (c) => new HttpKernel(this.app, c.resolve(Router), c.resolve(ExceptionHandler), c.resolve(Logger)),
    )
  }

  async boot() {
    const config = this.app.config<HttpConfig | undefined>('http') ?? {}
    const kernel = this.app.resolve(HttpKernel)
    const router = this.app.resolve(Router)
    if (config.public !== false)
      kernel.publicDir = join(this.app.rootDir, typeof config.public === 'string' ? config.public : 'public')
    kernel.global.push(securityHeaders(), bodyLimit(config.bodyLimit ?? '1mb'), ...(config.middleware ?? []))

    if (config.health !== false) {
      router.load((r) => {
        r.get('/health/live', () => kernel.health('live')).name('health.live')
        r.get('/health/ready', () => kernel.health('ready')).name('health.ready')
      })
    }
    const groups: [file: string, group: GroupOptions][] = [
      [
        'routes/web.ts',
        {
          middleware: [
            session(),
            csrf(),
            ...this.app.tagged<Middleware>(WEB_MIDDLEWARE),
            ...(config.groups?.web ?? []),
          ],
          group: 'web',
        },
      ],
      [
        'routes/api.ts',
        {
          middleware: [
            ...(config.cors ? [cors(config.cors)] : []),
            ...this.app.tagged<Middleware>(API_MIDDLEWARE),
            ...(config.groups?.api ?? []),
          ],
          group: 'api',
        },
      ],
    ]
    for (const [file, group] of groups) {
      const path = join(this.app.rootDir, file)
      if (!existsSync(path)) continue
      const mod = (await import(path)) as { default?: (r: RouteRegistrar) => void }
      if (typeof mod.default !== 'function')
        throw new Error(`${file} must \`export default defineRoutes((r) => { … })\``)
      router.load(mod.default, group)
    }
    kernel.compile()
  }

  async shutdown() {
    const timeout = this.app.config<string | number | undefined>('http.shutdownTimeout') ?? '10s'
    const { parseDuration } = await import('@cslug/core')
    await this.app.resolve(HttpKernel).stop(parseDuration(timeout))
  }
}
