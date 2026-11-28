# Design decisions

Each decision lists what was **decided** or **proposed**, the **alternatives**, and **why**.

| Mark | Meaning |
|---|---|
| ✅ | Decided by the product owner (review of 2026-11-26) |
| ⚑ | Proposed, needs sign-off (see [open-questions.md](./open-questions.md)) |
| — | Proposed, low risk |

Feedback received so far: name the app (the name stays private) ✅ · use **Vue islands**, not Inertia ✅ · typed tables
and repositories **without Drizzle** ✅ · **almost zero dependencies** ✅ · **scoped `@cslug/*` packages** ✅ · **static shortcuts are fine** ✅ · **folders by type, `booking-repository.ts` naming** ✅ ·
**standard decorators** ✅ · **islands rendered on the server by default** ✅ · **queue on Redis Streams** ✅ ·
**Vue as the server template language** ✅ · **HMR for islands in `cslug dev`, over SSE** (reopened 2026-11-28) ✅.

---

## D0. Almost zero dependencies ✅

The framework has **no runtime dependencies**. It is built on Bun's built-ins and the platform:

| Need | Built on |
|---|---|
| HTTP server, routing | `Bun.serve` (native `routes`) |
| PostgreSQL | `Bun.sql` |
| Redis (cache, locks, sessions, queue, schedule locks) | `Bun.redis` |
| Passwords | `Bun.password` (argon2id) |
| Files, S3 | `Bun.file`, `Bun.s3` |
| Hashing, HMAC, random | `Bun.CryptoHasher`, Web Crypto, `Bun.randomUUIDv7()` |
| Server-side templates | `vue/server-renderer` (part of `vue`) |
| Asset bundling | `Bun.build` (+ cslug plugins) |
| Formatting, plurals | `Intl` |
| Tests | `bun test` |
| HTTP clients (mail APIs, AI, payment partner) | `fetch` |

What cslug therefore writes itself: router, validator (`v`), SQL query builder and migration differ,
queue (on Redis Streams), cron parser, SMTP client, AI provider clients, template renderer.
Each is kept small and is documented as its own module.

**Allowed exceptions**, all *peer dependencies* of `@cslug/vue`, installed only by apps with HTML pages:

| Package | Why it cannot reasonably be avoided | Used when |
|---|---|---|
| `vue` | Views, components, islands and mail are Vue; `vue` also contains `vue/compiler-sfc` and `vue/server-renderer` | Any HTML view |
| `sass` | SCSS compilation | A `.scss` file exists |
| `tailwindcss` + `bun-plugin-tailwind` | Tailwind compilation | `--tailwind` |

Dev-only: `typescript`, `vue-tsc` (type-checks `.vue` files), `@biomejs/biome`.

**Rule:** a new dependency needs a written justification in this file. "It saves us a few hundred lines" is not
enough; "it is a compiler, a protocol we cannot reimplement safely, or a security primitive" is.

---

## D1. Scoped packages: `@cslug/*` ✅

The framework is a set of small packages under the `@cslug` scope, so an app installs only what it uses. A
simple app never pulls in `@cslug/ai`, and an API never pulls in Vue. The full list, dependency graph and release
process are in [packages.md](./packages.md).

```ts
import { inject, ServiceProvider, config, t, Money } from '@cslug/core'
import { type HttpContext, redirect, route } from '@cslug/http'
import { v, Validator } from '@cslug/validation'
import { table, id, uuid, text, Repository, sql } from '@cslug/database'
import { Job, defineSchedule } from '@cslug/queue'
import { view, useT, useRequest, useForm, Assets, type Serialized } from '@cslug/vue'
import { Mailable } from '@cslug/mail'
import { Agent, Tool } from '@cslug/ai'                // only if installed
import { testApp } from '@cslug/testing'
```

Lessons from strav, where 27 packages drifted apart:

- **15 packages, not 27.** Small concerns are merged into core (i18n, the cache/lock/rate-limiter contracts) or
  into their natural host (the scheduler into `@cslug/queue`).
- **Lockstep versions** and one release script. Nothing can drift.
- **Contracts in core, drivers in packages**, and optional integrations detected at runtime, so packages don't
  import each other just to cooperate.
- **Every package peer-depends on `@cslug/core`**, so an app always has exactly one container.

**Superseded:** the earlier proposal of one `cslug` package with subpath imports. It was simpler to release,
but every app would have installed everything.

---

## D2. Dependency injection: standard decorators, `@inject(A, B)` ✅

```ts
@inject(Database, PaymentGateway, Logger)
export class EscrowService {
  constructor(private db: Database, private gateway: PaymentGateway, private log: Logger) {}
}
```

TC39 standard decorators, TypeScript's default mode (no `experimentalDecorators`, no `emitDecoratorMetadata`,
no `reflect-metadata`). The list names the constructor's dependencies in order. `inject` is typed so that
**`tsc` rejects a list that doesn't match the constructor** (missing, extra-required or out-of-order
dependencies). Tokens for values (`token<number>('…')`) go in the same list and are type-checked too.

A spike on Bun 1.3.14 + TypeScript 7.0.2 confirmed it runs and that mismatches are compile errors.

**Rejected: legacy `@inject()`** (constructor types read from emitted metadata). It is shorter, but mistakes
surface at runtime, `import type` silently erases a dependency, primitives need a separate parameter-decorator
syntax, and metadata emission differs between tools. The side-by-side comparison is kept in
[guides/02 § Why not legacy decorators](../guides/02-container-and-di.md#why-not-legacy-decorators).

---

## D3. HTTP: own router and kernel; `Bun.serve` for the socket —

A Laravel-style routes file (named routes, groups, middleware, resources, controller tuples, domain routing,
constraints, URL generation and signed URLs) is compiled into cslug's own matcher. `Bun.serve` only handles the
socket and calls the kernel.

**Changed during implementation (M3a):** the routes were first meant to compile to `Bun.serve({ routes })`. The
kernel matches them itself instead:
- the same pipeline then runs in tests **without a port** (`kernel.handle(request)`);
- domain routing, 405 with `Allow`, `HEAD`→`GET` and parameter constraints need cslug logic anyway;
- matching is negligible next to request handling (spike d: ~23k req/s either way).

**Alternatives.** Hono: excellent, but it is a dependency and brings a second context object.

---

## D4. Validation: cslug's own `v`, Standard Schema compliant —

`v` is cslug's validator, with a Zod-like API, so it looks familiar to developers and AI models alike:

```ts
const StoreTripRequest = v.object({
  circuitId: v.uuid(),
  groupSize: v.int().min(1).max(12),
  budget: v.money({ currencies: ['EUR', 'USD'] }),
})
type StoreTripRequest = v.infer<typeof StoreTripRequest>
```

- It implements the [Standard Schema](https://standardschema.dev) interface, so Zod, Valibot or ArkType schemas
  are accepted wherever a `v` schema is (for teams that want them; they are not dependencies).
- `schema.toJSONSchema()` is built in. The same schema describes an HTTP body, a job payload, an AI tool input,
  an AI structured output and an OpenAPI document.
- A `Validator` class adds DI, async checks and custom messages.

**Why not Zod?** D0. The subset of Zod that apps actually use (objects, primitives, refinements, coercion,
defaults, unions, JSON Schema) is about 1,500 lines.

**Rejected:** strav's `FormRequest` with `authorize()` inside. Authorization belongs in policies.

---

## D5. Views: Vue on the server, components hydrated as islands ✅

- ✅ **Vue islands**, not Inertia: pages are rendered on the server; interactive parts hydrate independently.
- ✅ **Vue is the server template language**: views, layouts, components and mail are `.vue` SFCs rendered with
  `vue/server-renderer`. Views are never hydrated. TSX views were
  considered and rejected: they would mean two template languages, and a static component could not become an
  island without being rewritten.
- ✅ **Islands render on the server by default**: no layout shift, crawlable. `:ssr="false"` opts out.
- **A component becomes an island where it is used**, by adding `hydrate="load|idle|visible|media:…"`. The same
  component can be static on one page and interactive on another. There is no separate islands folder.
- **Types**: `cslug typecheck` runs `vue-tsc`, which checks templates, component props and `view(Page, props)`.

```vue
<!-- resources/views/bookings/show.vue -->
<script setup lang="ts">
import MilestoneTimeline from '#components/milestone-timeline.vue'
defineProps<{ booking: Booking }>()
</script>

<template>
  <Layout :title="booking.ref">
    <h1>{{ booking.ref }}</h1>
    <MilestoneTimeline :booking-id="booking.id" hydrate="visible" />
  </Layout>
</template>
```

**Assets:** `Bun.build` with cslug plugins for `.vue` (via `vue/compiler-sfc`), `.scss` (via `sass`) and
Tailwind (via `bun-plugin-tailwind`). No Vite. In development: rebuild on change + live reload over SSE.
**Reopened 2026-11-28 ✅:** state-preserving HMR for island `.vue` files under `cslug dev` (on by default, `--no-hmr`
turns it off), over the existing SSE channel: no WebSockets. A changed SFC is compiled alone and swapped in through
Vue's `__VUE_HMR_RUNTIME__` (`rerender` for template-only edits, `reload` otherwise). Stylesheets are swapped without a
reload (as before); other changes, server-only templates and failures still reload the page; server code still
restarts the process. Never in `cslug start` or with `app.env=production`: it needs Vue's development build.

**No built-in components** apart from `<Assets>`: no `<Head>`, `<Form>`, `<Field>` or mail components. Layout
slots, plain markup and `useRequest()` cover them, and apps make their own components when a pattern repeats.
There is no separate view package: `view()` and everything Vue-facing live in `@cslug/vue`, so `@cslug/http` stays Vue-free.

**Forms:** classic HTML forms work without JavaScript (validate → redirect back with errors and old input).
Islands that submit with `fetch` use `useForm()` from `@cslug/vue`, which understands the 422 error format.

---

## D6. Database: own typed tables, repositories and query builder on `Bun.sql` ✅

Tables are declared in TypeScript; row types are inferred; queries are built by a small typed builder or written
as tagged SQL with typed results. No Drizzle, no ORM.

```ts
export const bookings = table('bookings', {
  id: id(),                                   // uuid v7 primary key
  travellerId: uuid().references(() => travellers),
  status: text().oneOf(BookingStatus.values).default('requested'),   // typed union + CHECK constraint
  currency: currency(),                       // char(3)
  total: amount(),                            // bigint, minor units
  notes: text().nullable(),                   // columns are NOT NULL unless .nullable()
  ...timestamps(),
})
export type Booking = Row<typeof bookings>

await this.bookings.where({ status: 'deposit_paid', startDate: gte(today) }).orderBy('startDate').all()

await this.db.many(sql`
  select ${bookings.star} from ${bookings}
  join ${operators} on ${operators.c.id} = ${bookings.c.operatorId}
  where ${operators.c.verificationStatus} = ${'verified'}`, bookings)       // typed Booking[]
```

- **Single-table queries** (90% of an app) use the builder: `where`, `orderBy`, `limit`, `first`, `all`, `count`,
  `exists`, `paginate`, `update`, `delete`, `lockForUpdate`.
- **Joins, aggregates, CTEs** use the `sql` tag. Interpolated tables and columns become quoted identifiers and
  values become bound parameters, so SQL injection is impossible through the API. Results are mapped and typed
  by passing a table, or with `sql<T>` for ad-hoc shapes.
- **Relations** are not an ORM feature. `preload(rows, { operator: belongsTo(operators, 'operatorId') })` avoids
  N+1 queries.
- **Migrations** are plain SQL files. `cslug make:migration --from-tables` diffs the tables against
  `information_schema` and writes the SQL (create/drop table, add/drop/alter column, indexes, foreign keys); renames
  are asked interactively.

**Alternatives.** Drizzle (rejected: D0). Active record (rejected: correct typing for `save()`-style models is a
project in itself). Raw SQL only (rejected: hand-written row types).

---

## D7. Ambient transactions, after-commit dispatch —

`db.transaction(async () => { … })` keeps the transaction in `AsyncLocalStorage`. Repositories and `db` calls
inside it use it automatically. Jobs, queued listeners, mail and notifications dispatched inside it are **held
until commit** and dropped on rollback. For money-critical jobs, `.durable()` writes an outbox row in the same
transaction (see [guides/11](../guides/11-queues-and-jobs.md#durable-dispatch)). `db.transaction(async (tx) => …)`
remains available for explicit style.

---

## D8. Redis: cache, locks, rate limits, sessions and an own queue on Redis Streams ✅

- **Cache, locks, rate limits, sessions:** `Bun.redis`.
- **Queue:** cslug's own, on **Redis Streams**: `XADD` to enqueue, consumer groups (`XREADGROUP`) for workers,
  `XACK` on success, `XAUTOCLAIM` to recover jobs from crashed workers after a lease timeout, a sorted set for
  delayed jobs, a hash for unique keys, a stream per queue. Retries with exponential backoff and jitter, timeouts,
  failed-job store, per-queue concurrency and rate limits. Multi-step operations are atomic Lua scripts.
- **Scheduler:** own 5-field cron parser + a Redis lock per `(entry, tick)` for once-per-tick across instances.

**Alternatives.** BullMQ (rejected: D0, and it brings `ioredis`). Postgres-backed queue (`SKIP LOCKED`), which
would make the outbox unnecessary. Worth keeping in mind if Redis ever becomes the weak point.

---

## D9. Static shortcuts ✅

Constructor injection is the default, and a few typed shortcuts exist for very common calls: `view()`,
`redirect()`, `route()`, `t()`, `config()`, `resolve()`, `Job.dispatch()`, `Event.emit()`. They read the current
application from ambient context, which the test kit replaces per test. No other facades.

---

## D10. Files: grouped by type, kebab-case names ✅

```
app/controllers/booking-controller.ts        app/repositories/booking-repository.ts
app/validators/store-booking-validator.ts    app/jobs/send-checkin-job.ts
app/services/escrow-service.ts               app/tables/booking-table.ts
resources/views/bookings/show.vue            resources/components/trip-request-form.vue
```

Laravel-style folders by type (`controllers/`, `policies/`, `validators/`, `services/`, …). The file name is the
class name in kebab-case with the role as the last word, and there are no dots before the extension. Discovery
scans the folders. See [directory-structure.md](./directory-structure.md).

**Rejected:** domain folders with dotted suffixes (`app/bookings/booking.repository.ts`), as proposed earlier.

---

## D11. Auth: sessions for the web, opaque tokens for APIs —

Redis sessions with CSRF for pages, hashed opaque tokens for APIs, `Bun.password`, magic links for travellers,
policies and gates. No JWT, no OAuth server.

---

## D12. Not in v1

ORM relations with lazy loading · databases other than Postgres · GraphQL · websockets · admin panel generator ·
plugin marketplace · payment-provider SDKs (the escrow partner is app code behind an abstract `PaymentGateway`) ·
SPA mode. (Vue state-preserving HMR was here until 2026-11-28: see D5.)

---

## D13. Workflows and durable runs: in, on Postgres and the queue ✅

Decided 2026-11-28 (M15), reversing the deferral in `ai-readiness.md` and the "workflow, durable" row of the strav
lessons below. Products built on cslug need multi-day processes (deposits waiting for a partner, refunds waiting
for a person, durable AI agent runs) and were writing them as chains of jobs with status columns.

- ✅ **`@cslug/workflow`**, replay-based durable execution: a workflow is an `@inject()` class whose `run(ctx, input)`
  is replayed from a journal (`cslug_workflow_steps`); `ctx.step`, `sleep`, `waitFor`, `waitForSignal`, `now`, `uuid`
  are journaled by position and name.
- ✅ **No new infrastructure**: the journal is in Postgres, wake-ups are queue jobs, one resume at a time per run
  through an advisory lock, events through core's `EventBus`. No Temporal or other server.
- ✅ **Steps commit with their journal entry** (exactly once for database effects, at least once for external calls:
  use idempotency keys).
- ❌ Not a general DAG or BPMN engine, no visual editor, no child workflows in the first version.

---

## Lessons from strav

| strav did | Cost observed | cslug does |
|---|---|---|
| 27 packages in lockstep | Publish and version scripts, drift | 15 packages, contracts in core, one release script (D1) |
| Custom `.strav` template language + Vue islands | Two languages, editor support from scratch | Vue everywhere; any component can be an island (D5) |
| Schema DSL with archetypes, own ORM | Large surface before a feature shipped | Typed tables + small builder + tagged SQL; no ORM (D6) |
| `FormRequest` + param-type reflection | An ADR and tuple-arity routes to work around it | `request.validate(X)`; policies (D4) |
| No static singletons at all | `defaultApp()` workarounds | A few typed shortcuts (D9) |
| AI as a large core (`brain`, MCP, RAG, workflow, durable) | Many concepts before the product needs them | Small `@cslug/ai` on existing primitives |

Kept from strav: the provider `register → boot → shutdown` contract with dependency ordering, per-unit-of-work
scopes, typed errors only, and docs shipping with code.
