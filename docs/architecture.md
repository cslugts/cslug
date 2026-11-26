# Architecture

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│ 3. Application   app/, routes/, config/, resources/         │
├─────────────────────────────────────────────────────────────┤
│ 2. Kernels       HttpKernel · WorkerKernel · SchedulerKernel│
│                  · ConsoleKernel · (McpKernel)              │
├─────────────────────────────────────────────────────────────┤
│ 1. Core          Container · Providers · Config · Events ·  │
│                  Logger · Errors · Ambient context          │
└─────────────────────────────────────────────────────────────┘
```

Core knows nothing about HTTP. Each kernel takes a booted `Application` and turns one unit of work
(a request, a job, a tick, a command) into calls on the container.

## The application

`bootstrap/app.ts` is the **only** place an application is constructed:

```ts
// bootstrap/app.ts
import { Application } from '@cslug/core'
import { providers } from './providers'

export function createApp() {
  return new Application({ root: import.meta.dir + '/..', configs }).useProviders(providers)   // configs from '#config/index'
}
```

```ts
// bootstrap/providers.ts
import { HttpProvider } from '@cslug/http'
import { VueProvider } from '@cslug/vue'
import { DatabaseProvider } from '@cslug/database'
import { RedisProvider } from '@cslug/redis'
import { QueueProvider, ScheduleProvider } from '@cslug/queue'
import { MailProvider } from '@cslug/mail'
import { NotificationProvider } from '@cslug/notification'
import { AuthProvider } from '@cslug/auth'
import { StorageProvider } from '@cslug/storage'
import { PaymentServiceProvider } from '#app/providers/payment-service-provider'

// One provider per installed package. Core (config, events, logger, i18n, in-memory drivers) needs none.
export const providers = [
  DatabaseProvider, RedisProvider, QueueProvider, ScheduleProvider, MailProvider, NotificationProvider,
  AuthProvider, StorageProvider, HttpProvider, VueProvider,
  PaymentServiceProvider,
]
```

`bin/cslug` (installed by `@cslug/cli`) calls `createApp()`, picks the kernel for the command
(`serve`, `queue:work`, `schedule:work`, anything else → console) and starts it.

## Container

| Method | Use |
|---|---|
| `app.singleton(Token, factory?)` | One instance per application |
| `app.scoped(Token, factory?)` | One instance per scope (request / job / command) |
| `app.bind(Token, factory)` | New instance on every resolve |
| `app.instance(Token, value)` | Register an existing value |
| `app.resolve(Token)` | Get a bound token, or **auto-build** an `@inject(...)` class |
| `app.when(Consumer).needs(Token).give(Impl)` | Contextual binding |
| `app.tag([A, B], 'name')` / `app.tagged('name')` | Collections (e.g. all `Tool`s) |

Unlike strav there is **one** resolve method: it returns a binding if one exists, otherwise builds the class
if it has `@inject(...)`, otherwise throws `BindingNotFoundError` naming the token and the chain that asked for it:

```
BindingNotFoundError: Cannot resolve PaymentGateway
  required by EscrowService (app/services/escrow-service.ts)
  required by BookingController (app/controllers/booking-controller.ts)
  Hint: PaymentGateway is abstract — bind an implementation in a provider:
        this.app.singleton(PaymentGateway, MangopayGateway)
```

Auto-built classes are **scoped by default** (fresh per request/job), and their singleton dependencies come
from the root container. Mark a class `@inject.singleton(...)` to share it application-wide.

## Service providers

```ts
export abstract class ServiceProvider {
  constructor(protected app: Application) {}
  /** Bind things. Never resolve here. */
  register?(): void
  /** Everything is registered. Connect, warm caches, listen to events. */
  boot?(): Promise<void> | void
  /** Reverse order on SIGTERM/SIGINT or app.shutdown(). */
  shutdown?(): Promise<void> | void
  /** Other providers that must boot first. */
  static dependsOn?: (typeof ServiceProvider)[]
}
```

- `register()` runs for all providers, then `boot()` runs in dependency order (topological sort; cycles,
  duplicates and missing dependencies throw at startup with a clear message).
- If a `boot()` throws, already-booted providers are shut down in reverse order, then the error is rethrown.
- Kernels can boot a **subset**: `cslug migrate` does not boot `HttpProvider`.

## Lifecycles

### Request

```
Bun.serve fetch
 → HttpKernel creates a scope + ambient context { requestId, locale?, user?, tx? }
 → global middleware (request id, logging, security headers, body limit, session, csrf)
 → route match → route middleware (auth, can, throttle, verify-signature …)
 → controller = scope.resolve(BookingController); controller.show(ctx)
 → return value → Response
     Response          → as is
     ViewResult        → HTML rendered from the Vue view (vue/server-renderer, streamed)
     object / array    → JSON
     null / undefined  → 204
 → errors → ExceptionHandler (RFC 9457 JSON for APIs, redirect-back-with-errors + old input for HTML
            forms, 422 JSON for island fetches, error page for HTML)
 → scope disposed
```

### Job

```
Worker reads job (XREADGROUP) → WorkerKernel creates scope + context { jobId, attempt }
 → payload validated against the job's schema (if declared)
 → job = scope.resolve(SendCheckinJob); await job.handle(payload)
 → success: XACK · throw: re-queue with backoff · out of attempts: job.failed(error) + failed store
 → worker crash: lease expires, another worker reclaims it (XAUTOCLAIM)
```

### Schedule tick

```
SchedulerKernel wakes each minute → for each due entry:
  acquire Redis lock schedule:{name}:{tickISO}  (NX, TTL = expected duration)
  → lock won: dispatch the job (default) or run inline; record run
  → lock lost: another instance has it; skip
```

### Console command

```
cslug <name> → ConsoleKernel boots providers declared by the command (default: all except http/view)
 → parse args against the command's signature → scope.resolve(Command).handle(args)
```

### Shutdown

On `SIGTERM`/`SIGINT`: stop accepting requests → wait for in-flight requests (`http.shutdownTimeout`) →
workers finish current jobs and stop taking new ones → scheduler stops → providers' `shutdown()` in reverse
order (close DB pool, Redis) → exit 0.

## Ambient context

One `AsyncLocalStorage` holds a `Context` object per unit of work:

| Field | Set by | Read by |
|---|---|---|
| `app` | kernel | `view()`, `t()`, `config()`, `resolve()`, `Job.dispatch()` |
| `scope` | kernel | `resolve()` |
| `requestId` / `jobId` | kernel | logger (every log line carries it) |
| `locale` | `locale()` middleware, job payload | `t()`, formatting helpers, mail |
| `user` | `auth` middleware | policies, `auth.user()`, audit fields |
| `tx` | `db.transaction()` | repositories, `db.query`, dispatch (after-commit) |

Rules: context is **read** anywhere, **written** only by the kernel, the middleware listed above, and
`db.transaction()`. Code that needs a different value says so explicitly (`t('key', {}, 'it')`,
`db.withoutTransaction(...)`, `withLocale('fr', fn)`).

## Errors

Typed errors only; each maps to a status and a stable `code`:

```ts
throw new NotFoundError('booking', id)                      // 404 booking.not_found
throw new ConflictError('booking.invalid_transition', { from, to })   // 409
throw new ForbiddenError()                                  // 403
throw new ValidationError({ email: ['validation.unique'] }) // 422
```

Apps extend `HttpError` / `AppError`. A plain `throw new Error()` becomes a 500 with the request ID, logged
with its stack; in production the response never contains the stack or SQL.
