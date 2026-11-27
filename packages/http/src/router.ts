import { type Class, CslugError } from '@cslug/core'
import type { Validatable } from '@cslug/validation'
import type { HttpContext, ValidatorClass } from './context'

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'
export type Next = () => Promise<Response>
/** A middleware function, or a class with `handle(ctx, next)` built by the container. */
export type MiddlewareFn = (ctx: HttpContext, next: Next) => Response | Promise<Response>
export type MiddlewareClass = Class<{ handle(ctx: HttpContext, next: Next): Response | Promise<Response> }>
export type Middleware = MiddlewareFn | MiddlewareClass

type ActionClass = Class<object>
/** `[Controller, 'method']`, a single-action controller class (`handle`), or a closure. */
export type Action =
  | readonly [ActionClass, string]
  | Class<{ handle(ctx: HttpContext): unknown }>
  | ((ctx: HttpContext) => unknown)

export type RouteDef = {
  method: Method
  path: string
  name?: string
  domain?: string
  action: Action
  middleware: Middleware[]
  wheres: Record<string, RegExp>
  meta: Record<string, unknown>
  /** The schema live validation checks this route's input against (`.validates(schema)`). */
  validates?: Validatable | ValidatorClass
}

export type GroupOptions = {
  prefix?: string
  /** Host to match, may contain parameters: `':operator.albastr.com'`. */
  domain?: string
  middleware?: Middleware[]
  /** Route-name prefix: `as: 'admin'` + `.name('show')` → `admin.show`. */
  as?: string
  /** Free-form metadata for packages (e.g. `ssr: false` for @cslug/vue). */
  [key: string]: unknown
}

const join = (a: string, b: string) => {
  const path = `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`.replace(/\/+$/, '')
  return path === '' ? '/' : path.startsWith('/') ? path : `/${path}`
}

/** The fluent handle returned by `r.get(...)`. */
export class RouteBuilder {
  constructor(
    readonly def: RouteDef,
    private readonly namePrefix: string,
  ) {}
  name(name: string): this {
    this.def.name = this.namePrefix ? `${this.namePrefix}.${name}` : name
    return this
  }
  middleware(...middleware: Middleware[]): this {
    this.def.middleware.push(...middleware)
    return this
  }
  /**
   * The schema this route validates its input with, for live validation (`form.validate()` in `@cslug/vue`): a
   * request with `X-Cslug-Validate` runs the route's middleware and this validation, answers 204 or 422, and never
   * calls the handler. The handler still calls `request.validate()` itself.
   */
  validates(schema: Validatable | ValidatorClass): this {
    this.def.validates = schema
    return this
  }
  /** Constrain a path or domain parameter: `.where('operator', /^[a-z0-9-]{3,40}$/)`. */
  where(param: string, pattern: RegExp): this {
    this.def.wheres[param] = pattern
    return this
  }
}

type Resource = 'index' | 'create' | 'store' | 'show' | 'edit' | 'update' | 'destroy'

/** What `defineRoutes` callbacks receive. */
export class RouteRegistrar {
  constructor(
    readonly routes: RouteDef[],
    private readonly scope: {
      prefix: string
      domain?: string
      middleware: Middleware[]
      as: string
      meta: Record<string, unknown>
    } = {
      prefix: '',
      middleware: [],
      as: '',
      meta: {},
    },
  ) {}

  private add(method: Method, path: string, action: Action): RouteBuilder {
    const def: RouteDef = {
      method,
      path: join(this.scope.prefix, path),
      domain: this.scope.domain,
      action,
      middleware: [...this.scope.middleware],
      wheres: {},
      meta: { ...this.scope.meta },
    }
    this.routes.push(def)
    return new RouteBuilder(def, this.scope.as)
  }

  get(path: string, action: Action) {
    return this.add('GET', path, action)
  }
  post(path: string, action: Action) {
    return this.add('POST', path, action)
  }
  put(path: string, action: Action) {
    return this.add('PUT', path, action)
  }
  patch(path: string, action: Action) {
    return this.add('PATCH', path, action)
  }
  delete(path: string, action: Action) {
    return this.add('DELETE', path, action)
  }
  options(path: string, action: Action) {
    return this.add('OPTIONS', path, action)
  }

  group(options: GroupOptions, routes: (r: RouteRegistrar) => void): void {
    const { prefix, domain, middleware, as, ...meta } = options
    routes(
      new RouteRegistrar(this.routes, {
        prefix: join(this.scope.prefix, prefix ?? ''),
        domain: domain ?? this.scope.domain,
        middleware: [...this.scope.middleware, ...(middleware ?? [])],
        as: [this.scope.as, as].filter(Boolean).join('.'),
        meta: { ...this.scope.meta, ...meta },
      }),
    )
  }

  /**
   * REST routes: `r.resource('operators', OperatorController)` → index, create, store, show, edit, update, destroy.
   * Nested: `r.resource('operators.documents', Ctl)` → `/operators/:operator/documents/:document`.
   */
  resource(name: string, controller: ActionClass) {
    const parts = name.split('.')
    const param = (p: string) =>
      (p.endsWith('ies') ? `${p.slice(0, -3)}y` : p.endsWith('s') ? p.slice(0, -1) : p).replace(
        /-([a-z])/g,
        (_, c: string) => c.toUpperCase(),
      )
    const base = parts.map((p, i) => (i < parts.length - 1 ? `${p}/:${param(p)}` : p)).join('/')
    const item = `${base}/:${param(parts.at(-1) as string)}`
    const table: [Resource, Method, string][] = [
      ['index', 'GET', base],
      ['create', 'GET', `${base}/create`],
      ['store', 'POST', base],
      ['show', 'GET', item],
      ['edit', 'GET', `${item}/edit`],
      ['update', 'PATCH', item],
      ['destroy', 'DELETE', item],
    ]
    const built = table.map(([action, method, path]) => {
      const route = this.add(method, path, [controller, action] as const).name(`${name}.${action}`)
      return { action, route }
    })
    return {
      only: (actions: Resource[]) => {
        for (const { action, route } of built)
          if (!actions.includes(action)) this.routes.splice(this.routes.indexOf(route.def), 1)
      },
      except: (actions: Resource[]) => {
        for (const { action, route } of built)
          if (actions.includes(action)) this.routes.splice(this.routes.indexOf(route.def), 1)
      },
    }
  }
}

/** A routes file: `export default defineRoutes((r) => { … })`. */
export const defineRoutes = (fn: (r: RouteRegistrar) => void) => fn

/** All routes of the app, with name lookup. */
export class Router {
  readonly routes: RouteDef[] = []

  /** Add routes (a `defineRoutes` function), optionally inside a group (the `web` / `api` groups). */
  load(fn: (r: RouteRegistrar) => void, group: GroupOptions = {}): this {
    new RouteRegistrar(this.routes).group(group, fn)
    return this
  }

  byName(name: string): RouteDef | undefined {
    return this.routes.find((r) => r.name === name)
  }

  /** Checks: duplicate names, and the same method+path+domain twice. Called when the kernel starts. */
  validate(): void {
    const names = new Set<string>()
    const keys = new Set<string>()
    for (const r of this.routes) {
      if (r.name) {
        if (names.has(r.name)) throw new CslugError('http.duplicate_route_name', `Two routes are named "${r.name}"`)
        names.add(r.name)
      }
      const key = `${r.method} ${r.domain ?? '*'} ${r.path}`
      if (keys.has(key)) throw new CslugError('http.duplicate_route', `Route defined twice: ${key}`)
      keys.add(key)
    }
  }
}
