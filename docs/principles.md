# Principles

"A simpler Laravel" is a useful slogan but a poor spec. These are the rules that make it concrete.
Every API proposal in `guides/` should be checked against them.

## 1. Laravel's shape, not Laravel's surface

We keep what makes Laravel productive:

- a **container** that builds your classes for you (`@inject()`),
- **service providers** as the one place where wiring happens,
- **controllers, validators, jobs, mailables, notifications, policies, commands** as small classes with one job each,
- **conventions over configuration** — a file in the right folder with the right name just works,
- one **CLI** (`cslug`) that runs, generates, migrates and inspects.

We drop what makes Laravel large: facades for everything, macros, multiple database drivers, a custom
template language, magic properties, a second way to do every common thing.

## 2. One way to do common things

If two APIs reach the same result, one of them is deleted. Where a shortcut exists (for example
`SendCheckin.dispatch(...)` instead of `queue.dispatch(SendCheckin, ...)`), the docs name **one** of them as
canonical and the other is documented as what it really is: sugar over the same call.

## 3. Types flow, nobody writes them twice

- A validator's schema **is** the request type. `await request.validate(X)` returns the inferred type.
- A table definition **is** the row type. `Booking` is `typeof bookings.$inferSelect`.
- A job's payload type **is** the `dispatch()` argument type.
- A config file **is** the type of `config('...')`.

If a guide example needs a hand-written interface that duplicates something else, the API is wrong.

## 4. Almost zero dependencies: Bun first, own the rest

cslug has **no runtime dependencies** ([D0](./decisions.md#d0-almost-zero-dependencies-)). It is built on Bun's
built-ins and writes the rest itself, kept small:

| Concern | Built on |
|---|---|
| HTTP server | `Bun.serve` (native routes) + own router |
| SQL | `Bun.sql` + own typed tables, query builder, `sql` tag, migration differ |
| Redis | `Bun.redis` for cache, locks, rate limits and an own queue on Redis Streams |
| Validation | Own `v` (Zod-like API, Standard Schema, JSON Schema export) |
| Views | Vue SFCs rendered on the server; components hydrated as islands; `Bun.build` for assets |
| Mail | Vue mail templates; own SMTP client + `fetch` transports |

The only optional peers are the asset compilers: `vue` (islands), `sass` (SCSS), `tailwindcss` (if chosen).

The framework source should stay readable in an afternoon per module. A module over ~1,500 lines is a
signal to split or simplify.

## 5. Correct by default for money

Albastr moves other people's money. Defaults are chosen for correctness, not speed:

- jobs dispatched inside a DB transaction are sent **after commit** (or not at all),
- schedules run **once per tick across all instances**,
- webhook handlers get **signature verification + idempotency** as a one-liner,
- money is **integer minor units + currency**, never a float,
- IDs are **UUIDv7**, timestamps are **`timestamptz` in UTC**.

## 6. Explicit where it matters, ambient where it helps

- **Explicit:** dependencies (constructor injection), routes (one routes file), providers (one list), config.
- **Ambient (per request / job / command):** the current transaction, the current locale, the current
  user, the request ID for logs. These ride on `AsyncLocalStorage`, are documented in one place
  ([architecture.md § Ambient context](./architecture.md#ambient-context)), and every one of them can be
  overridden explicitly.

## 7. Built for AI — both directions

- **AI features in the app** use the same building blocks as everything else: an `Agent` is a class with
  `@inject()`, a `Tool`'s input is a validator, long runs are jobs. See [ai-readiness.md](./ai-readiness.md).
- **AI coding agents working on the app** get strong conventions, generators, typed everything, an
  `AGENTS.md`, and `cslug describe --json` / an MCP server to introspect routes, tables, jobs and config.

## 8. Small surface, documented completely

Every exported symbol has a doc comment and appears in its module's `api.md`. If it is not worth
documenting, it is not worth exporting.
