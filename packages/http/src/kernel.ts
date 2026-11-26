import {
  type Application,
  currentContext,
  HEALTH_CHECKS,
  type HealthCheck,
  Logger,
  NotFoundError,
  runInContext,
  type Token,
} from '@cslug/core'
import { type HttpContext, HttpRequest, ResponseBuilder } from './context'
import type { ExceptionHandler } from './errors'
import { isResponsable, json } from './responses'
import type { Middleware, MiddlewareFn, Next, RouteDef, Router } from './router'
import { MissingSession } from './session'
import { serveStatic } from './static'

type Compiled = { route: RouteDef; path: RegExp; domain?: RegExp; score: number[] }

const toRegExp = (pattern: string, separator: '/' | '.') =>
  new RegExp(
    `^${pattern
      .split(separator)
      .map((seg) =>
        seg.startsWith(':')
          ? `(?<${seg.slice(1)}>[^${separator === '/' ? '/' : '.'}]+)`
          : seg === '*'
            ? '(?<wildcard>.*)'
            : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join(separator === '/' ? '/' : '\\.')}$`,
    'i',
  )

/** Static segments beat parameters, parameters beat wildcards; routes with a domain come first. */
const scoreOf = (r: RouteDef) => [
  r.domain ? 1 : 0,
  ...r.path.split('/').map((s) => (s === '*' ? 0 : s.startsWith(':') ? 1 : 2)),
]
const compareScores = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? -1) - (a[i] ?? -1)
    if (d) return d
  }
  return 0
}

const decode = (v: string) => {
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * Turns a `Request` into a `Response`: request id, context and scope, route matching (domain, path, method,
 * constraints), middleware, the action, result → Response, errors → ExceptionHandler. `handle()` needs no port,
 * which is how @cslug/testing calls it; `listen()` puts it behind `Bun.serve`.
 */
export class HttpKernel {
  private compiled: Compiled[] = []
  /** Middleware run for every request (before routing). */
  readonly global: Middleware[] = []
  private server?: ReturnType<typeof Bun.serve>

  constructor(
    readonly app: Application,
    readonly router: Router,
    private readonly errors: ExceptionHandler,
    private readonly log: Logger = Logger.null(),
  ) {}

  /** Serve files from this folder for GET/HEAD requests that match no route (`public/`; `http.public: false` turns it off). */
  publicDir?: string

  /** Compile the router's routes (called at boot; call again after adding routes). */
  compile(): this {
    this.router.validate()
    this.compiled = this.router.routes
      .map((route) => ({
        route,
        path: toRegExp(route.path === '/' ? '' : route.path, '/'),
        domain: route.domain ? toRegExp(route.domain, '.') : undefined,
        score: scoreOf(route),
      }))
      .sort((a, b) => compareScores(a.score, b.score))
    return this
  }

  /** Find the route for a method, host and path; `allowed` lists methods that exist for the path (for 405). */
  match(method: string, host: string, path: string) {
    const allowed = new Set<string>()
    const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path
    for (const c of this.compiled) {
      const d = c.domain ? c.domain.exec(host) : null
      if (c.domain && !d) continue
      const m = c.path.exec(normalized === '/' ? '' : normalized)
      if (!m) continue
      const params: Record<string, string> = {}
      for (const [k, v] of Object.entries({ ...d?.groups, ...m.groups })) if (v !== undefined) params[k] = decode(v)
      if (Object.entries(c.route.wheres).some(([k, re]) => params[k] === undefined || !re.test(params[k]))) continue
      allowed.add(c.route.method)
      if (c.route.method === method || (method === 'HEAD' && c.route.method === 'GET'))
        return { route: c.route, params, allowed }
    }
    return { route: undefined, params: {}, allowed }
  }

  /** Handle one request (no network needed). */
  async handle(request: Request, info: { ip?: string } = {}): Promise<Response> {
    const started = performance.now()
    const given = request.headers.get('x-request-id')
    const requestId = given && REQUEST_ID.test(given) ? given : Bun.randomUUIDv7()
    const scope = this.app.createScope()
    const url = new URL(request.url)
    const host = (request.headers.get('host') ?? url.host).replace(/:\d+$/, '').toLowerCase()
    const ip = this.clientIp(request, info.ip)
    const req = new HttpRequest(request, scope, ip)
    const response = new ResponseBuilder()
    const defaultLocale = this.app.config<string | undefined>('i18n.default') ?? 'en'
    const ctx: HttpContext = {
      request: req,
      params: {},
      response,
      app: this.app,
      scope,
      requestId,
      signal: request.signal,
      log: this.log.child({ requestId }),
      locale: defaultLocale,
      session: new MissingSession(),
      resolve: <K extends Token>(token: K) => scope.resolve(token) as never,
    }
    let status = 500
    let routeName: string | undefined
    try {
      return await runInContext(
        { ...(currentContext() ?? {}), app: this.app, scope, requestId, locale: defaultLocale, http: ctx },
        async () => {
          const run = async (): Promise<Response> => {
            // HTML forms can only send GET/POST: `<input name="_method" value="PUT">` spoofs the others
            let method = request.method
            if (method === 'POST' && req.isForm) {
              const spoofed = (await req.body())._method
              if (typeof spoofed === 'string' && ['PUT', 'PATCH', 'DELETE'].includes(spoofed.toUpperCase()))
                method = spoofed.toUpperCase()
            }
            const { route, params, allowed } = this.match(method, host, url.pathname)
            if (!route) {
              if (this.publicDir && (request.method === 'GET' || request.method === 'HEAD')) {
                const file = serveStatic(this.publicDir, url.pathname, request)
                if (file) return file
              }
              if (allowed.size) {
                const allow = [...allowed, ...(allowed.has('GET') ? ['HEAD'] : [])].join(', ')
                return json(
                  { title: 'Method Not Allowed', status: 405, code: 'http.method_not_allowed', requestId },
                  { status: 405, headers: { allow } },
                )
              }
              throw new NotFoundError('route')
            }
            routeName = route.name
            Object.assign(ctx.params, params)
            Object.assign(ctx, { routeName: route.name })
            return this.pipeline(ctx, route.middleware, () => this.callAction(ctx, route))
          }
          let res: Response
          try {
            res = await this.pipeline(ctx, this.global, run)
          } catch (error) {
            res = await this.errors.handle(error, ctx)
          }
          res = this.finalize(res, ctx, request.method)
          status = res.status
          return res
        },
      )
    } finally {
      await scope.dispose()
      this.log.info('request', {
        method: request.method,
        path: url.pathname,
        status,
        ms: Math.round((performance.now() - started) * 10) / 10,
        route: routeName,
        requestId,
      })
    }
  }

  private finalize(res: Response, ctx: HttpContext, method: string): Response {
    const headers = new Headers(res.headers)
    ctx.response.headers.forEach((v, k) => {
      if (k === 'set-cookie') headers.append(k, v)
      else if (!headers.has(k)) headers.set(k, v)
    })
    headers.set('x-request-id', ctx.requestId)
    const status = ctx.response.status ?? res.status
    return new Response(method === 'HEAD' ? null : res.body, { status, statusText: res.statusText, headers })
  }

  private pipeline(ctx: HttpContext, middleware: Middleware[], last: Next): Promise<Response> {
    const fns: MiddlewareFn[] = middleware.map((m) =>
      isMiddlewareClass(m)
        ? (c, next) => (ctx.scope.resolve(m) as { handle: MiddlewareFn }).handle(c, next)
        : (m as MiddlewareFn),
    )
    const dispatch = (i: number): Promise<Response> => {
      const fn = fns[i]
      return fn ? Promise.resolve(fn(ctx, () => dispatch(i + 1))) : last()
    }
    return dispatch(0)
  }

  private async callAction(ctx: HttpContext, route: RouteDef): Promise<Response> {
    const action = route.action
    let result: unknown
    if (Array.isArray(action)) {
      const [cls, method] = action as [new () => object, string]
      const controller = ctx.scope.resolve(cls) as Record<string, unknown>
      const fn = controller[method]
      if (typeof fn !== 'function')
        throw new Error(`${cls.name} has no method "${method}" (route ${route.method} ${route.path})`)
      result = await (fn as (c: HttpContext) => unknown).call(controller, ctx)
    } else if (isClass(action)) {
      const controller = ctx.scope.resolve(action) as { handle(c: HttpContext): unknown }
      result = await controller.handle(ctx)
    } else result = await (action as (c: HttpContext) => unknown)(ctx)
    return toResponse(result, ctx)
  }

  private clientIp(request: Request, socketIp: string | undefined): string | undefined {
    const trusted = this.app.config<string[] | undefined>('http.trustedProxies') ?? []
    const loopback = socketIp === '127.0.0.1' || socketIp === '::1' || socketIp?.startsWith('::ffff:127.') === true
    const isTrusted =
      socketIp !== undefined && (trusted.includes(socketIp) || (trusted.includes('loopback') && loopback))
    const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    return isTrusted && forwarded ? forwarded : socketIp
  }

  /** Serve over HTTP. */
  listen(options: { port?: number; hostname?: string; reusePort?: boolean } = {}) {
    this.compile()
    const port = options.port ?? this.app.config<number | undefined>('http.port') ?? 3000
    this.server = Bun.serve({
      port,
      hostname: options.hostname ?? this.app.config<string | undefined>('http.host'),
      reusePort: options.reusePort,
      maxRequestBodySize: this.app.config<number | undefined>('http.maxBodyBytes') ?? 10 * 1024 * 1024,
      fetch: (req, server) => this.handle(req, { ip: server.requestIP(req)?.address }),
    })
    return this.server
  }

  /** Stop accepting requests, wait for in-flight ones up to `timeoutMs`, then close what is left. */
  async stop(timeoutMs = 10_000): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    const graceful = server.stop(false)
    const timedOut = await Promise.race([graceful.then(() => false), Bun.sleep(timeoutMs).then(() => true)])
    if (timedOut) await server.stop(true)
  }

  /** `/health/live` and `/health/ready` (runs every check tagged `HEALTH_CHECKS`). */
  async health(kind: 'live' | 'ready'): Promise<Response> {
    if (kind === 'live') return json({ status: 'ok' })
    const checks = this.app.tagged<HealthCheck>(HEALTH_CHECKS)
    const results = await Promise.all(
      checks.map(async (c) => {
        try {
          await c.check()
          return [c.name, 'ok'] as const
        } catch (e) {
          return [c.name, (e as Error).message ?? 'failed'] as const
        }
      }),
    )
    const ok = results.every(([, r]) => r === 'ok')
    return json({ status: ok ? 'ok' : 'unavailable', checks: Object.fromEntries(results) }, { status: ok ? 200 : 503 })
  }
}

const isClass = (v: unknown): v is new (...a: never[]) => unknown =>
  typeof v === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(v))
const isMiddlewareClass = (m: Middleware) => isClass(m)

/** A handler's return value → Response. */
export async function toResponse(result: unknown, ctx: HttpContext): Promise<Response> {
  if (result instanceof Response) return result
  if (isResponsable(result)) return result.toResponse(ctx)
  if (result === null || result === undefined) return new Response(null, { status: 204 })
  if (typeof result === 'string')
    return new Response(result, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
  return json(result)
}
