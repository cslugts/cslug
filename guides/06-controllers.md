# Controllers

A controller is an `@inject()` class whose methods (actions) take an `HttpContext` and return a value.
Keep them thin: validate, authorize, call a service, return a response.

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

The controller is built per request, so injecting scoped services (current user, request-bound cache) is safe.

## The context

```ts
async show({ request, params, auth, session, response, locale, signal, log }: HttpContext) {}
```

| Field | What |
|---|---|
| `params` | Route params (`params.booking`), strings |
| `request` | `validate(V)`, `query(key)`, `input(key)`, `json()`, `raw()` (bytes, for signatures), `file(key)`, `header(key)`, `ip()`, `wantsJson()` |
| `auth` | `user()`, `check()`, `authorize(Policy, ability, …args)`, `can(...)`, `login(user)`, `logout()` |
| `session` | `get`, `put`, `flash`, `regenerate()` |
| `response` | Cookies and headers on the outgoing response (`response.cookie(...)`, `response.header(...)`) |
| `locale` | Current locale (`'fr' \| 'en' \| 'it'`) |
| `signal` | `AbortSignal` — aborted on client disconnect or `timeout()` |
| `log` | The logger for this request: its lines carry the request id, the user and the trace |

## What an action may return

| Return | Becomes |
|---|---|
| `view(Page, props)` | HTML rendered from a Vue view on the server (props checked by `cslug typecheck`) |
| plain object / array | `200` JSON (bigint → string, Date → ISO, `Money` as `{ amount, currency }`) |
| a string | `200` `text/plain` |
| `created(data)`, `accepted(data)` | `201` / `202` JSON |
| `null` / `undefined` | `204` |
| `redirect()…` | `302`/`303` (`303` after PUT/PATCH/DELETE) |
| `download(file, name)`, `stream(iterable)`, `sse(iterable)` | File / streamed / server-sent events |
| a `Response` | sent as-is |

```ts
return redirect().back().with('success', t('saved'))
return redirect().route('bookings.show', { booking: id })
return redirect().away(checkoutUrl)                          // external
return redirect().intended(route('bookings.index'))          // after login
```

## Errors

Throw, don't build error responses by hand:

```ts
const booking = await this.bookings.findOrFail(params.booking)   // NotFoundError → 404
await auth.authorize(BookingPolicy, 'cancel', booking)            // ForbiddenError → 403
BookingStatus.assert(booking.status, 'cancelled')                 // ConflictError → 409
```

The exception handler picks the format: problem+json for API requests, 422 JSON for island `fetch` calls, or
redirect-back-with-errors for page requests.

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

Same controllers; return data. For a stable public shape use a **transformer** (`app/transformers/`), which is just a typed mapper:

```ts
// app/transformers/operator-transformer.ts
export const operatorTransformer = (o: Operator) => ({
  id: o.id,
  name: o.displayName,
  verified: o.verificationStatus === 'verified',
  rating: o.ratingAvg,
})

// controller (paginate from '@cslug/http')
return paginate(await this.operators.verified({ page }), operatorTransformer)
```
