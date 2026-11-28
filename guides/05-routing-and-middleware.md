# Routing & middleware

Routes are declared in `routes/web.ts` (HTML pages: session, CSRF) and `routes/api.ts` (JSON: tokens, webhooks).
`HttpProvider` loads them at boot, if they exist, with the `web` and `api` middleware groups. `ScheduleProvider`
loads `routes/schedule.ts` (guide 12). More files (`routes/admin.ts`) are imported from one of these and mounted
with a group: `r.group({ … }, admin.routes)`.

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

```ts
// routes/admin.ts
import type { RouteRegistrar } from '@cslug/http'

export const routes = (r: RouteRegistrar) => {
  r.get('/', [AdminDashboardController, 'index']).name('dashboard')       // admin.dashboard
  r.resource('operators', OperatorAdminController)
}
```

### Methods and actions

`r.get`, `r.post`, `r.put`, `r.patch`, `r.delete` and `r.options` take a path and an action:

| Action | Example |
|---|---|
| a controller method | `[BookingController, 'show']` |
| a single-action class (its `handle`) | `ReleaseStageController` |
| a closure | `(ctx) => ({ ok: true })`: fine for tiny routes; logic goes in a controller |

`HEAD` is answered by the `GET` route without a body. A path that exists with other methods answers **405** with
an `Allow` header. HTML forms can only send GET and POST: a form POST with a hidden `_method` field (`PUT`,
`PATCH`, `DELETE`) is routed as that method.

### Parameters

```ts
r.get('/bookings/:booking', …)                         // params.booking, URL-decoded string
r.get('/bookings/:booking/stages/:stage', …)           // several
r.get('/ref/:ref', …).where('ref', /^ALB-[A-Z0-9]{6}$/) // constrained: no match → the next route, or 404
r.get('/docs/*', …)                                    // a wildcard: params.wildcard is the rest of the path
```

Static segments beat parameters, and parameters beat wildcards, whatever the order of declaration. A trailing
slash is ignored, and matching is case-insensitive.

### Names

Names are joined with dots: `as: 'bookings'` + `.name('show')` → `bookings.show`. Give a name to every route you
link to: `route()`, redirects and islands use names, never paths.

### Group options

| Option | Example | Effect |
|---|---|---|
| `prefix` | `'/admin'`, `'/:locale'` | Path prefix; may contain params |
| `domain` | `'api.example.com'`, `':operator.example.com'` | Matches the `Host` header; may contain params |
| `middleware` | `[auth(), can('admin.access')]` | Runs for every route in the group |
| `as` | `'admin'` | Route-name prefix (`admin.` + name) |
| anything else | `{ section: 'admin' }` | Free-form metadata, read by packages |

Options combine, and groups nest. An inner group adds its prefix, middleware and name to the outer group's.

### Resource routes

```ts
r.resource('operators', OperatorController)                // the seven REST routes below
r.resource('operators', OperatorController).only(['index', 'show', 'update'])
r.resource('operators', OperatorController).except(['destroy'])
r.resource('operators.documents', OperatorDocumentController) // /operators/:operator/documents/:document
```

| Action | Method and path | Name |
|---|---|---|
| `index` | `GET /operators` | `operators.index` |
| `create` | `GET /operators/create` | `operators.create` |
| `store` | `POST /operators` | `operators.store` |
| `show` | `GET /operators/:operator` | `operators.show` |
| `edit` | `GET /operators/:operator/edit` | `operators.edit` |
| `update` | `PATCH /operators/:operator` | `operators.update` |
| `destroy` | `DELETE /operators/:operator` | `operators.destroy` |

`cslug make:controller Operator --resource` writes a controller with those methods.

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

A domain parameter matches **one** DNS label. Constrain it like any parameter:
`.where('operator', /^[a-z0-9-]{3,40}$/)`.

### Domains per environment

Hard-coded hosts break on `localhost` and staging, so put them in config:

```ts
// config/http.ts
export default defineConfig({
  domains: {
    app: env.APP_DOMAIN,                    // 'example.com'          | 'localhost'
    api: env.API_DOMAIN,                    // 'api.example.com'      | 'api.localhost'
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

- Routes **with** a domain are tried before routes without one. A route without a domain matches any host, as a
  fallback.
- The host is the `Host` header, compared without the port, case-insensitively. Behind a proxy, make sure it
  forwards the original `Host`.
- The same path may exist on several domains (`GET /` on `example.com` and on `partners.example.com`).
- `cslug routes` shows the domain in the path column (`//api.example.com/v1/quotes`).

### URLs to other domains

`route()` knows each route's domain. A route on another host comes back as an absolute URL:

```ts
route('api.quotes.index')                                        // 'https://api.example.com/v1/quotes'
route('operator-site.home', { operator: 'ravinala-tours' })      // 'https://ravinala-tours.example.com/'
```

### Cookies and sessions across subdomains

Sessions are per host by default. To share a login between `example.com` and `partners.example.com`, set
`domain: '.example.com'` in `config/session.ts`. Leave it unset when subdomains belong to different parties
(operator sites).

## URLs from names

```ts
import { route } from '@cslug/http'

route('bookings.show', { booking: booking.id })            // '/bookings/0193…'
route('public.circuits.show', { locale: 'it', slug })      // '/it/circuits/tana-isalo'
route('bookings.index', { page: 2 })                       // '/bookings?page=2': unknown params → query string
route('todos.index', {}, { query: { filter: 'open' } })    // '/todos?filter=open'
route('bookings.show', { booking: id }, { absolute: true }) // 'https://example.com/bookings/0193…' (app.url)
```

### Signed URLs

A signed URL carries an HMAC of itself (made with `APP_KEY`), so it cannot be changed or forged, and optionally
an expiry. Links in emails ("download your trip pack", "confirm your address") use them instead of a login:

```ts
const url = route('bookings.trip-pack', { booking: id }, { absolute: true, signed: true, expiresIn: '7d' })
```

```ts
import { signed } from '@cslug/http/middleware'

r.get('/bookings/:booking/trip-pack', [BookingController, 'tripPack']).name('bookings.trip-pack').middleware(signed())
// a changed or expired URL → 403 http.invalid_signature
```

Signatures survive a key rotation: URLs signed with a key in `APP_PREVIOUS_KEYS` still verify (guide 26). Outside
the app (a script), `urlFor(router, appUrl, encrypter, name, params, options)` and
`verifySignedUrl(url, encrypter)` do the same (`APP_KEY` itself works in place of the encrypter).

The same `route()` exists in islands (`import { route } from '@cslug/vue'`), from a route list that `<Assets>`
embeds in pages with islands. By default every named route is listed; `vue.routes` in `config/vue.ts` limits it to
some name prefixes (`['public', 'bookings']`) so admin routes stay out of public pages.

## Middleware

A middleware receives the context and `next`, and returns a `Response`. It can act before the handler (refuse,
set something on the context) and after it (change the response).

A class with `handle`, built by the container (so it can inject services):

```ts
// app/middleware/require-verified-operator-middleware.ts
import { ForbiddenError, inject } from '@cslug/core'
import type { HttpContext, Next } from '@cslug/http'
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

`cslug make:middleware RequireVerifiedOperator` writes the class. Simple ones are just functions:

```ts
import type { Middleware } from '@cslug/http'

export const noIndex = (): Middleware => async (_ctx, next) => {
  const res = await next()
  res.headers.set('X-Robots-Tag', 'noindex')
  return res
}
```

Attach middleware to a group (`middleware: [...]`), to one route (`.middleware(a, b)`), to every route of
`web.ts` or `api.ts` (`http.groups.web` / `http.groups.api` in `config/http.ts`), or to every request
(`http.middleware`: global, before routing, so it also runs for 404s and static files).

### Built-in middleware

| Middleware | Where | Notes |
|---|---|---|
| `securityHeaders({ hsts?, csp?, frameOptions? })` | global | `X-Content-Type-Options`, `X-Frame-Options` (`DENY`), `Referrer-Policy`, `Cross-Origin-Opener-Policy`, HSTS in production, a fixed CSP if you give one (a CSP with nonces: `@cslug/security`, guide 24) |
| `bodyLimit('1mb')` | global | 413 over the limit, on the declared size and on the bytes read. Per route: `.middleware(bodyLimit('20mb'))` for uploads; `http.bodyLimit` changes the global one |
| `session()`, `csrf()` | `web` group | The session, and 419 for a POST/PUT/PATCH/DELETE without the token (`_token` field or `X-CSRF-Token` header). Webhooks and other callers without a session belong in `routes/api.ts`, which has neither. `csrf({ except: ['/exact/path', /^\/callbacks\//] })` in a group of your own skips some paths |
| `cors({ origins, methods?, headers?, credentials?, maxAge? })` | `api` group, from `http.cors` | Answers preflights; `origins: ['*']` allows any origin, without credentials |
| `statefulApi(origins?)` | `api` group, with `http.api.stateful` | Session and CSRF for requests from the app's own pages (below) |
| `throttle('5/min', key?)` | per route | 429 with `Retry-After`; `X-RateLimit-Limit/Remaining`. Keyed by route and user (else IP), or your function |
| `locale()` | per group | The request's locale (guide 16) |
| `timeout('10s')` | per route | 503 after the duration; `ctx.signal` aborts, so `fetch` and queries given the signal stop too |
| `signed()` | per route | 403 unless the URL is a valid, unexpired signed URL |
| `auth(guard?)`, `guest()`, `can(ability)`, `ability('todos:write')` | per group | From `@cslug/auth` (guide 15) |
| `verifySignature(source)` | per route | Webhooks, from `@cslug/webhook` (guide 17) |
| `csp()`, `ipFilter()`, `ipLimit()` | global or per group | From `@cslug/security` (guide 24) |

Every request gets an id (`X-Request-Id` when the client sends a valid one, else a UUIDv7) returned in the
response and present on every log line, and one log line when it ends (method, path, status, duration, route).
That is the kernel's job: no middleware to add.

### Islands calling the API: `statefulApi`

Routes in `api.ts` have no session, so an island's `fetch` to them would not be signed in. With
`http.api.stateful: true`, requests that come **from the app's own pages** (their `Origin`, or `Referer`, or
`Sec-Fetch-Site: same-origin`, is `app.url`'s origin) get the session and CSRF, so `useForm` and `http` from
`@cslug/vue` reach `routes/api.ts` as the signed-in user. Other clients still use API tokens. A list of origins
instead of `true` allows other front-ends (`['https://app.example.com']`).

### Middleware from packages

A package adds middleware to the `web` or `api` group by tagging it (`this.app.tag([token], WEB_MIDDLEWARE)` /
`API_MIDDLEWARE` in its provider); `@cslug/auth` adds `authenticate()` this way, which knows the user before any
route middleware runs.

## Static files

GET and HEAD requests that match no route are served from `public/` (`http.public`: another folder, or `false`).
Dotfiles and paths escaping the folder are refused. Hashed build files (`client-1a2b3c4d.js`) get
`Cache-Control: public, max-age=31536000, immutable`; other files revalidate with an `ETag` and answer 304 when
unchanged.

## Health endpoints

`GET /health/live` answers 200 while the process runs; `GET /health/ready` runs every registered check (the
database's, Redis's) and answers 503 if one fails. Load balancers and `cslug start` use them (guide 21). Add a
check of your own in a provider:

```ts
import { HEALTH_CHECKS, healthCheck } from '@cslug/core'

register() {
  this.app.singleton(healthCheck('payments'), () => ({
    name: 'payments',
    check: () => this.app.resolve(PaymentGateway).ping(),
  }))
  this.app.tag([healthCheck('payments')], HEALTH_CHECKS)
}
```

`http.health: false` removes both endpoints.

## Configuration

```ts
// config/http.ts
export default defineConfig({
  port: env.PORT,                       // default 3000
  host: '0.0.0.0',
  shutdownTimeout: '10s',               // SIGTERM: in-flight requests get this long to finish
  bodyLimit: '1mb',
  public: 'public',                     // or false
  trustedProxies: ['loopback', '10.0.0.12'],   // exact addresses (or 'loopback'): X-Forwarded-For is read only from these (guide 21)
  cors: { origins: ['https://partner.example.com'], credentials: true },
  api: { stateful: true },
  groups: { web: [noIndex()], api: [] },
  middleware: [],                       // global, after the defaults
  problemBase: 'https://example.com/errors',   // `type` of problem+json responses
  health: true,
})
```

## Listing routes

```bash
$ cslug routes
METHOD  PATH                                  NAME                   ACTION                           MIDDLEWARE
GET     /:locale/circuits/:slug               public.circuits.show   CircuitController.show           session, csrf, locale
POST    /bookings/:booking/accept             bookings.accept        BookingController.accept         session, csrf, auth
POST    /webhooks/payments                    webhooks.payments      PaymentWebhookController.handle  verifySignature
GET     //api.example.com/v1/quotes           api.quotes.index       QuoteController.index            auth, throttle
```

`cslug routes booking` keeps the routes whose path or name contains `booking`; `--json` prints them as data, and
`cslug describe routes` is the same list for scripts and AI agents.
