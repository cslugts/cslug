# Controllers

A controller is an `@inject()` class whose methods (actions) take an `HttpContext` and return a value. Keep them
thin: validate, authorize, call a service, return a response.

## Anatomy

```ts
// app/controllers/trip-request-controller.ts
import { inject, t } from '@cslug/core'
import { type HttpContext, redirect } from '@cslug/http'
import { view } from '@cslug/vue'
import CreateTripRequest from '#views/trip-requests/create.vue'
import { CircuitRepository } from '#app/repositories/circuit-repository'
import { TripRequestService } from '#app/services/trip-request-service'
import { StoreTripRequestValidator } from '#app/validators/store-trip-request-validator'

@inject(CircuitRepository, TripRequestService)
export class TripRequestController {
  constructor(private circuits: CircuitRepository, private tripRequests: TripRequestService) {}

  async create({ request }: HttpContext) {
    return view(CreateTripRequest, {
      circuits: await this.circuits.published(),
      preselected: request.query('circuit'),
    })
  }

  async store({ request }: HttpContext) {
    const data = await request.validate(StoreTripRequestValidator)
    const tripRequest = await this.tripRequests.open(data)
    return redirect()
      .route('public.trip-requests.thanks', { ref: tripRequest.ref })
      .with('success', t('trip_requests.received'))
  }
}
```

`cslug make:controller TripRequest` writes the class (`--resource` adds the seven REST actions of
`r.resource()`, guide 05). The controller is built per request, so injecting scoped services (the current user, a
request-bound cache) is safe.

## The context

```ts
async show({ request, params, auth, session, response, locale, signal, log }: HttpContext) {}
```

| Field | What |
|---|---|
| `params` | Route and domain parameters, URL-decoded strings (`params.booking`) |
| `request` | The incoming request (below) |
| `response` | Status, headers and cookies of the outgoing response |
| `auth` | `user()`, `check()`, `authorize(Policy, ability, …args)`, `can(…)`, `login(user)`, `logout()` (`@cslug/auth`, guide 15) |
| `user` | The signed-in user or `null` (with `@cslug/auth`) |
| `session` | The session (in `web.ts` routes, below) |
| `locale` | The current locale (`'fr'`), set by the `locale()` middleware |
| `signal` | An `AbortSignal`, aborted when the client disconnects or `timeout()` fires: pass it to `fetch` and long work |
| `log` | The logger for this request: its lines carry the request id, the user and the trace |
| `requestId` | The request's id (also the `X-Request-Id` response header) |
| `routeName` | The matched route's name |
| `nonce` | The CSP nonce (with `@cslug/security`, guide 24) |
| `resolve(token)` | Resolve from the request's container |
| `app`, `scope` | The application and the request's container |

### The request

```ts
request.method                           // 'POST'
request.path                             // '/bookings/0193…/accept'
request.url                              // a URL object (search params included)
request.header('accept-language')
request.query('page')                    // one query-string value (string | undefined)
request.queryAll()                       // every query-string value (repeated keys → arrays)
await request.body()                     // the parsed body: JSON, or a form (a[b]=1 → { a: { b: '1' } }; files as File)
await request.input('email')             // one value: the body for writes, the query for GET
await request.file('document')           // a File from a multipart form
await request.raw()                      // the exact bytes (webhook signatures)
request.cookie('locale')
request.ip()                             // the client's address (guide 21: proxies)
request.isJson / request.isForm          // the body's type
request.wantsJson()                      // the client prefers JSON (Accept header, or a fetch from an island)
await request.validate(V)                // parse, check and type the input (guide 07)
```

Prefer `validate()` for anything you store: `body()` and `input()` are untyped and unchecked.

### The response

```ts
response.status = 202
response.header('Cache-Control', 'no-store')
response.cookie('locale', 'fr', { maxAge: 60 * 60 * 24 * 365 })
// options: maxAge (seconds), httpOnly (default true), secure (default: in production), sameSite ('lax'), path, domain
```

These are merged into whatever the action returns (a header the returned response already has wins).

### The session

In `routes/web.ts` routes (the `session()` middleware; `@cslug/redis` stores it in Redis):

```ts
session.put('cart', cart)
session.get<Cart>('cart')
session.has('cart'); session.forget('cart'); session.pull('cart')   // pull: get and forget
session.flash('success', t('saved'))       // for the next request only (or redirect().with())
session.reflash()                          // keep this request's flashes one more request
session.regenerate()                       // a new session id (auth.login() does it)
session.invalidate()                       // empty it and change the id (auth.logout() does it)
```

`config/session.ts`: `cookie` (`cslug_session`), `lifetime` (`'14d'`), `sameSite`, `domain`. The cookie is
HttpOnly, and Secure in production.

## What an action may return

| Return | Becomes |
|---|---|
| `view(Page, props)` | HTML rendered from a Vue view on the server (props checked by `cslug typecheck`) |
| a plain object / array | `200` JSON (bigint → string, Date → ISO, `Money` as `{ amount, currency }`) |
| a string | `200` `text/plain` |
| `json(data, init?)` | JSON with a status and headers of your choice |
| `created(data)`, `accepted(data)`, `noContent()` | `201` / `202` JSON, `204` |
| `null` / `undefined` | `204` |
| `redirect()…` | `302`, or `303` after POST/PUT/PATCH/DELETE |
| `download(content, filename, type?)` | A file to save (`Content-Disposition: attachment`) |
| `stream(asyncIterable, type?)` | A streamed body |
| `sse(asyncIterable)` | Server-sent events |
| a `Response` | Sent as is |
| a `Responsable` | Anything with `toResponse(ctx)`: `view()` is one |

```ts
import { created, download, json, redirect, sse, stream } from '@cslug/http'

return created({ id: booking.id })
return json({ error: 'gone' }, { status: 410, headers: { 'cache-control': 'no-store' } })

// a CSV export, built as it is sent
return stream(
  (async function* () {
    yield 'ref,status\n'
    for await (const b of this.bookings.where({ operatorId }).each()) yield `${b.ref},${b.status}\n`
  })(),
  'text/csv',
)

return download(await this.tripPacks.pdf(booking), `trip-pack-${booking.ref}.pdf`, 'application/pdf')

// live progress for a page (EventSource in the browser); each item is sent as JSON
return sse(this.importer.progress(importId))
```

### Redirects

```ts
return redirect().route('bookings.show', { booking: id })   // to a named route
return redirect().to('/bookings')                           // a local path
return redirect().away(checkoutUrl)                         // another site
return redirect().back('/bookings')                         // where the request came from (Referer), else the fallback
return redirect().intended(route('bookings.index'))         // the page a guest wanted before logging in
return redirect().back().with('success', t('saved'))        // flash a message for the next page
```

`.with()` and `.intended()` need the session (web routes). When an island posts with `useForm` (the request has
`X-Cslug-Request: 1`), a redirect is answered `204` with `X-Cslug-Redirect: <url>` instead, so the island can
navigate; flashes are kept.

## Errors

Throw, don't build error responses by hand:

```ts
import { AppError, ConflictError, NotFoundError } from '@cslug/core'

const booking = await this.bookings.findOrFail(params.booking)   // NotFoundError → 404 booking.not_found
await auth.authorize(BookingPolicy, 'cancel', booking)            // ForbiddenError → 403
BookingStatus.assert(booking.status, 'cancelled')                 // ConflictError → 409 booking.invalid_transition
throw new AppError('payments.declined', undefined, { status: 402, params: { reason } })
```

| Error | Status | Code |
|---|---|---|
| `ValidationError` | 422 | `validation.failed`, with `errors` per field |
| `NotFoundError(resource?, id?)` | 404 | `<resource>.not_found` |
| `UnauthorizedError(code?)` | 401 | `auth.unauthenticated` |
| `ForbiddenError(code?)` | 403 | `auth.forbidden` |
| `ConflictError(code, params?)` | 409 | yours |
| `BadRequestError(code?)` | 400 | `http.bad_request` |
| `TooManyRequestsError(retryAfter?)` | 429 | `http.too_many_requests`, with `Retry-After` |
| `AppError(code, message?, { status, params })` | yours (500 by default) | yours |
| anything else | 500 | logged with the stack |

The code is a translation key: the message shown is `t(code, params)` in the request's locale, so
`resources/lang/fr.json` has `"payments": { "declined": "Paiement refusé : {reason}." }`.

The exception handler picks the format:

- **API clients** (`Accept: application/json`, `routes/api.ts`): `application/problem+json` with `type`, `title`,
  `status`, `code`, `params`, `requestId` (and `errors` for 422).
- **Islands** (`useForm`): the same JSON, which `form.errors` reads.
- **Pages**: a validation error redirects back with the errors and the old input (guide 07); other errors render a
  minimal HTML page with the status and message.
- **500s** say nothing about the cause in production (the request id lets you find the log line); in development
  they show the error and a short stack.

### Rendering and reporting errors yourself

```ts
// app/providers/app-service-provider.ts
import { ExceptionHandler } from '@cslug/http'

boot() {
  const handler = this.app.resolve(ExceptionHandler)
  // a custom response for some errors (the first renderer that returns a Response wins)
  handler.render((error, ctx) => {
    if (error instanceof PaymentGatewayDown && !ctx.request.wantsJson()) return view(MaintenancePage, {}, { status: 503 })
  })
  // be told of every 5xx (an error tracker)
  handler.report((error, ctx) => this.app.resolve(ErrorTracker).capture(error, { requestId: ctx?.requestId }))
}
```

## Single-action controllers

When a controller has one job, name it after the job and implement `handle`:

```ts
@inject(EscrowService)
export class ReleaseStageController {
  constructor(private escrow: EscrowService) {}
  async handle({ params, auth }: HttpContext) { … }
}

r.post('/admin/bookings/:booking/release', ReleaseStageController).name('admin.bookings.release')
```

## JSON APIs

The same controllers, returning data. For a stable public shape use a **transformer** (`app/transformers/`), which
is just a typed mapper:

```ts
// app/transformers/operator-transformer.ts
export const operatorTransformer = (o: Operator) => ({
  id: o.id,
  name: o.displayName,
  verified: o.verificationStatus === 'verified',
  rating: o.ratingAvg,
})

// controller
async index({ request }: HttpContext) {
  const { page } = await request.validate(v.object({ page: v.int().min(1).default(1) }))
  const result = await this.operators.paginate({ page, perPage: 20, where: { verificationStatus: 'verified' } })
  return { data: result.data.map(operatorTransformer), meta: result.meta }   // meta: page, perPage, total, lastPage
}
```

API routes live in `routes/api.ts`: no session or CSRF; clients authenticate with API tokens (guide 15), and
islands with the session when `http.api.stateful` is on (guide 05).
