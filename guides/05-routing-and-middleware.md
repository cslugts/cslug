# Routing & middleware

Routes are declared in `routes/web.ts` (HTML pages, session, CSRF) and `routes/api.ts` (JSON, tokens,
webhooks). They compile to `Bun.serve({ routes })` at boot.

**How route files load.** `HttpProvider` loads `routes/web.ts` (with the `web` middleware group) and
`routes/api.ts` (with the `api` group) at boot, if they exist. `ScheduleProvider` loads `routes/schedule.ts`.
More files (for example `routes/admin.ts`) are imported from one of these: `r.group({ … }, admin.routes)`.

## Routes

```ts
// routes/web.ts
import { defineRoutes } from '@cslug/http'
import { locale, throttle } from '@cslug/http/middleware'
import { auth, can, guest } from '@cslug/auth'
import { HomeController } from '#app/controllers/home-controller'
import { CircuitController } from '#app/controllers/circuit-controller'
import { TripRequestController } from '#app/controllers/trip-request-controller'
import { BookingController } from '#app/controllers/booking-controller'
import { MagicLinkController } from '#app/controllers/magic-link-controller'
import * as admin from '#routes/admin'

export default defineRoutes((r) => {
  r.get('/', [HomeController, 'redirectToLocale'])

  // Public, localised, server-rendered pages: /fr/circuits/tana-isalo
  r.group({ prefix: '/:locale', middleware: [locale()], as: 'public' }, (r) => {
    r.get('/', [HomeController, 'index']).name('home')
    r.get('/circuits/:slug', [CircuitController, 'show']).name('circuits.show')
    r.get('/visa', [HomeController, 'visa']).name('visa')
    r.get('/trip-request', [TripRequestController, 'create']).name('trip-requests.create')
    r.post('/trip-request', [TripRequestController, 'store']).middleware(throttle('5/min')).name('trip-requests.store')
  })

  r.group({ middleware: [guest()] }, (r) => {
    r.post('/login/link', [MagicLinkController, 'send']).middleware(throttle('3/min'))
    r.get('/login/link/:token', [MagicLinkController, 'consume']).name('login.consume')
  })

  r.group({ prefix: '/bookings', middleware: [auth()], as: 'bookings' }, (r) => {
    r.get('/', [BookingController, 'index']).name('index')
    r.get('/:booking', [BookingController, 'show']).name('show')
    r.get('/:booking/pay', [BookingController, 'pay']).name('pay')
    r.post('/:booking/accept', [BookingController, 'accept']).name('accept')
    r.get('/:booking/trip-pack', [BookingController, 'tripPack']).name('trip-pack')
  })

  r.group({ prefix: '/admin', middleware: [auth(), can('admin.access')], as: 'admin' }, admin.routes)
})
```

Names are joined with dots: `as: 'bookings'` + `.name('show')` → `bookings.show`.

### Group options

| Option | Example | Effect |
|---|---|---|
| `prefix` | `'/admin'`, `'/:locale'` | Path prefix; may contain params |
| `domain` | `'api.example.com'`, `':operator.example.com'` | Matches the `Host` header; may contain params |
| `middleware` | `[auth(), can('admin.access')]` | Runs for every route in the group |
| `as` | `'admin'` | Route-name prefix (`admin.` + name) |
| `ssr` | `false` | Default `:ssr` for islands on pages of the group |

Options combine, and groups nest. An inner group adds its prefix, middleware and name to the outer group's.

## Domain routing

A group with `domain` only matches requests whose `Host` is that domain:

```ts
// routes/api.ts
import { defineRoutes } from '@cslug/http'
import { throttle } from '@cslug/http/middleware'
import { auth } from '@cslug/auth'

export default defineRoutes((r) => {
  // https://api.example.com/v1/quotes
  r.group({ domain: 'api.example.com', prefix: '/v1', middleware: [auth('token'), throttle('60/min')], as: 'api' }, (r) => {
    r.get('/quotes', [QuoteController, 'index']).name('quotes.index')
    r.post('/quotes', [QuoteController, 'store']).name('quotes.store')
  })

  // https://partners.example.com/…: operator portal on its own host
  r.group({ domain: 'partners.example.com', middleware: [auth()], as: 'partners' }, (r) => {
    r.get('/', [OperatorDashboardController, 'index']).name('dashboard')
    r.get('/bookings/:booking', [OperatorBookingController, 'show']).name('bookings.show')
  })
})
```

### Domain parameters

Parts of the host can be parameters, like path parameters, and they appear in `params` next to them:

```ts
// https://ravinala-tours.example.com/: a public page per verified operator
r.group({ domain: ':operator.example.com', as: 'operator-site' }, (r) => {
  r.get('/', [OperatorSiteController, 'home']).name('home')
  r.get('/circuits/:slug', [OperatorSiteController, 'circuit']).name('circuits.show')
})
```

```ts
@inject(OperatorRepository)
export class OperatorSiteController {
  constructor(private operators: OperatorRepository) {}

  async home({ params }: HttpContext) {
    const operator = await this.operators.findByOrFail({ subdomain: params.operator })   // 'ravinala-tours'
    return view(OperatorHome, { operator })
  }
}
```

A domain parameter matches **one** DNS label (`[a-z0-9-]+`). Constrain it like any parameter:
`.where('operator', /^[a-z0-9-]{3,40}$/)`.

### Domains per environment

Hard-coded hosts break on `localhost` and staging, so put them in config:

```ts
// config/http.ts
export default defineConfig({
  domains: {
    app: env.APP_DOMAIN,                    // 'example.com'        | 'localhost'
    api: env.API_DOMAIN,                    // 'api.example.com'    | 'api.localhost'
    partners: env.PARTNERS_DOMAIN,          // 'partners.example.com' | 'partners.localhost'
  },
})
```

```ts
r.group({ domain: config('http.domains.api'), prefix: '/v1' }, …)
r.group({ domain: `:operator.${config('http.domains.app')}` }, …)
```

`*.localhost` resolves to `127.0.0.1` in modern browsers and in `curl`, so subdomains work in development
without editing `/etc/hosts`.

### Matching rules

- Routes **with** a domain are tried before routes without one. A route without a domain matches any host,
  as a fallback.
- The host is compared without the port, case-insensitively. Behind a proxy, `X-Forwarded-Host` is used only
  when the proxy is listed in `http.trustedProxies`.
- The same path may exist on several domains (`GET /` on `example.com` and on `partners.example.com`).
- `cslug routes` shows the domain column, and `cslug routes --domain=api.example.com` filters by it.

### URLs to other domains

`route()` knows each route's domain. A route on another host comes back as an absolute URL:

```ts
route('api.quotes.index')                                        // 'https://api.example.com/v1/quotes'
route('operator-site.home', { operator: 'ravinala-tours' })      // 'https://ravinala-tours.example.com/'
route('partners.dashboard')                                      // relative ('/') when already on partners.example.com
```

### Cookies and sessions across subdomains

Sessions are per host by default. To share a login between `example.com` and `partners.example.com`, set
`session.cookieDomain: '.example.com'` in `config/session.ts`. Leave it unset when subdomains belong to
different parties (operator sites).

### Resource routes

```ts
r.resource('operators', OperatorController)                // index, create, store, show, edit, update, destroy
r.resource('operators', OperatorController).only(['index', 'show', 'update'])
r.resource('operators.documents', OperatorDocumentController) // /operators/:operator/documents/:document
```

### Closures

Fine for tiny routes; anything with logic goes in a controller.

```ts
r.get('/health/live', () => ({ ok: true }))
```

## URLs from names

```ts
import { route } from '@cslug/http'

route('bookings.show', { booking: booking.id })            // '/bookings/0193…'
route('public.circuits.show', { locale: 'it', slug })      // '/it/circuits/tana-isalo'
route('login.consume', { token }, { absolute: true, signed: true, expiresIn: '30m' })
route('todos.index', {}, { query: { filter: 'open' } })     // '/todos?filter=open'
```

The same `route()` exists in islands (`import { route } from '@cslug/vue'`), driven by a route list that
`<Assets>` embeds in the page (only routes in `web.ts`, or marked `.public()`).

## Middleware

A middleware is a function, or a class with `handle`, that receives the context and `next`:

```ts
// app/middleware/require-verified-operator-middleware.ts
import { inject } from '@cslug/core'
import { type HttpContext, type Next, ForbiddenError } from '@cslug/http'
import { OperatorRepository } from '#app/repositories/operator-repository'

@inject(OperatorRepository)
export class RequireVerifiedOperatorMiddleware {
  constructor(private operators: OperatorRepository) {}

  async handle({ auth }: HttpContext, next: Next) {
    const operator = await this.operators.forUser(auth.user().id)
    if (operator?.verificationStatus !== 'verified') throw new ForbiddenError('operators.not_verified')
    return next()
  }
}

// use it
r.group({ prefix: '/operator', middleware: [auth(), RequireVerifiedOperatorMiddleware] }, …)
```

Simple ones are just functions:

```ts
export const noIndex = (): Middleware => async (_ctx, next) => {
  const res = await next()
  res.headers.set('X-Robots-Tag', 'noindex')
  return res
}
```

### Built-in middleware

| Middleware | Default | Notes |
|---|---|---|
| `requestId()` | global | Accepts `X-Request-Id` or makes a UUIDv7; added to every log line |
| `logRequests()` | global | One structured line per request |
| `securityHeaders()` | global | CSP, HSTS (prod), frame, referrer, nosniff |
| `bodyLimit('1mb')` | global | Per route: `.middleware(bodyLimit('20mb'))` for uploads |
| `session()`, `csrf()` | `web` group | Session in the `SessionStore` (Redis with `@cslug/redis`); 419 without the CSRF token (`_token` field or `X-CSRF-Token`). A failed form post redirects back with errors and old input automatically |
| `cors(...)` | `api` group | From `config/http.ts` |
| `auth(guard?)`, `guest()` | — | From `@cslug/auth`. `auth('token')` for API tokens |
| `can(ability)` | — | From `@cslug/auth`. Gate check (see [guide 15](./15-auth-and-authorization.md)) |
| `ability('todos:write')` | — | From `@cslug/auth`. The API token must carry this ability (with `auth('token')`) |
| `throttle('5/min', key?)` | — | Redis sliding window; key defaults to user or IP |
| `locale()` | — | From `:locale` param → user setting → `Accept-Language` |
| `verifySignature(name)` | — | Webhooks (see [guide 17](./17-storage-and-webhooks.md)) |
| `timeout('10s')` | — | Aborts the handler's `AbortSignal` |

`web.ts` routes get the `web` middleware group automatically and `api.ts` routes get the `api` group
(no session, no CSRF). Neither adds a URL prefix; use a group for `/api/v1`.

## Listing routes

```bash
$ cslug routes
DOMAIN                  METHOD  PATH                        NAME                   ACTION                           MIDDLEWARE
*                       GET     /:locale/circuits/:slug     public.circuits.show   CircuitController.show           web, locale
*                       POST    /bookings/:booking/accept   bookings.accept        BookingController.accept         web, auth
*                       POST    /webhooks/payments          webhooks.payments      PaymentWebhookController.handle  api, verifySignature(payments)
api.example.com         GET     /v1/quotes                  api.quotes.index       QuoteController.index            api, auth(token), throttle
:operator.example.com   GET     /                           operator-site.home     OperatorSiteController.home      web
```

`cslug routes --json` adds the validator and body schema for each route (see `cslug describe`).
