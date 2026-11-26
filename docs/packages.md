# Packages

cslug is a set of small packages under the `@cslug` scope, developed in one monorepo and released together.
An app installs only what it uses: an API without HTML pages never installs Vue, and an app without AI never
installs `@cslug/ai`.

## Package list

| Package | Owns | Depends on | Built on |
|---|---|---|---|
| `@cslug/validation` | `v` (schemas, coercion, refinements, JSON Schema export, Standard Schema), `Validator`, `ValidationError` | — | — |
| `@cslug/core` | `Application`, container, `@inject`, `token`, `ServiceProvider`, config + env, events, logger, typed errors, ambient context, `Clock`, `Money`, **i18n** (`t()`, formatting), **contracts** (`Cache`, `Lock`, `RateLimiter`, `SessionStore`) with in-memory drivers | validation | `AsyncLocalStorage`, `Intl` |
| `@cslug/http` | Router (incl. domain routing), middleware, `HttpContext`, request/response, cookies, sessions (via `SessionStore`), CSRF, CORS, `throttle()` (via `RateLimiter`), error rendering, static files, `/health/*` | core, validation | `Bun.serve` |
| `@cslug/vue` | `view()`, `renderStandalone()`, server `.vue` loader, `hydrate` → island transform, composables (`useT`, `useRequest`, `useForm`, `defineStore`), `route()`, formatters, `<Assets>`, `serialize()`, `Serialized<T>`, `mountIslands()`; build plugins at `@cslug/vue/build`; test preload `@cslug/vue/register` | http, validation (ICU messages in islands) · **peer: `vue`** · optional peers: `sass`, `tailwindcss`, `bun-plugin-tailwind` | `vue/server-renderer`, `vue/compiler-sfc`, `Bun.build` |
| `@cslug/database` | `Database`, column builders, `Row`/`NewRow`, query builder, `sql` tag, `Repository`, `preload`, transactions (+ `afterCommit` hooks in core context), locks, idempotency, migrations + differ, factories, seeders | core | `Bun.sql` |
| `@cslug/redis` | `Redis` connections, Lua helper; Redis drivers for core's `Cache`, `Lock`, `RateLimiter`, `SessionStore` | core | `Bun.redis` |
| `@cslug/queue` | `Job`, workers on Redis Streams, retries, delays, unique jobs, chains, batches, after-commit dispatch; **scheduler** (`defineSchedule`, cron, once-per-tick locks); durable outbox when `@cslug/database` is present | core, redis · optional: database | Redis Streams |
| `@cslug/auth` | Session and token guards, `Hash` (argon2id), magic links, TOTP, `Policy`, `gate`, `ability()` middleware | core, http, database | `Bun.password`, Web Crypto |
| `@cslug/mail` | `Mailer`, `Mailable`, CSS inlining + text part, transports: SMTP (own client), Resend/Postmark/Brevo (`fetch`), `log`, `array` | core · optional: vue (templates), queue (queued mail) | `Bun.connect`, `fetch` |
| `@cslug/notification` | `Notifier`, `Notification`, channels: mail, database, whatsapp, sms; delivery records | core · optional: mail, queue, database | — |
| `@cslug/storage` | `Storage` disks (local, s3), signed URLs, upload type sniffing | core | `Bun.file`, `Bun.s3` |
| `@cslug/webhook` | `verifySignature()`, `WebhookInbox` (exactly-once receipt), replay command | http, database | Web Crypto |
| `@cslug/ai` | `Agent`, `Tool`, structured output, streaming, MCP server/client, providers (Anthropic, OpenAI-compatible, fake) | core, validation · optional: queue | `fetch` |
| `@cslug/cli` | The `cslug` binary, `Command`, generators, `repl`, `describe`, `dev`, `start` supervisor | core | `Bun.spawn` |
| `@cslug/testing` | `testApp()`, HTTP/HTML assertions, DB isolation, fakes, time travel | peers: every package it fakes | `bun test` |
| `create-cslug` | `bun create cslug` scaffolder (literal template files) | — | — |

No package has a runtime dependency outside `@cslug/*`. The only third-party packages are `vue` (a peer of
`@cslug/vue`) and the optional asset compilers.

## Dependency graph

```
                         @cslug/validation
                                │
                           @cslug/core  ◄──────────── every package (peer dependency)
      ┌───────────┬────────────┼────────────┬───────────┬───────────┬──────────┐
  @cslug/http  @cslug/database  @cslug/redis  @cslug/storage  @cslug/ai   @cslug/cli
      │   │        │   │          │
      │   └─► @cslug/vue           └─► @cslug/queue ◄·· database (optional: outbox)
      │            │   │
      ├────────────┴───┴─► @cslug/auth (http + database)
      └──────────────────► @cslug/webhook (http + database)

  @cslug/mail ··► vue, queue (optional)        @cslug/notification ··► mail, queue, database (optional)
  ─► required     ··► optional peer
```

## Rules

1. **Contracts live in core, drivers in packages.** `Cache`, `Lock`, `RateLimiter` and `SessionStore`
   are abstract classes in `@cslug/core` with in-memory implementations. `@cslug/redis` binds Redis
   implementations when its provider is listed. `@cslug/http`'s `throttle()` and sessions therefore work without
   Redis in development and tests.
2. **Every package peer-depends on `@cslug/core`** (and on any `@cslug/*` package it builds on). An app always
   has exactly **one** copy of core, so one container, one ambient context and one `@inject` registry.
3. **Optional integrations are detected, not imported.** `@cslug/queue` holds jobs until commit through core's
   `afterCommit()` hook, which `@cslug/database` drives. It never imports `@cslug/database`. The durable outbox is
   enabled only if `Database` is bound.
4. **Each package has one provider** (`HttpProvider`, `DatabaseProvider`, …), listed in `bootstrap/providers.ts`.
   Core's own services (config, events, logger, i18n, in-memory drivers) need no provider.
5. **Packages contribute CLI commands through their provider** (`this.commands([MigrateCommand, …])`).
   `@cslug/cli` knows nothing about databases or queues. `cslug migrate` exists only if `@cslug/database` is
   installed.
6. **Public API = the package's `src/index.ts`.** No deep imports between packages (`@cslug/http/src/...` is a
   lint error). Subpath exports only where documented (`@cslug/http/middleware`, `@cslug/vue/build`, `@cslug/vue/register`).
7. **No cycles.** CI checks the graph above against the `package.json` files.

## Versioning and releases

- **Lockstep.** All packages share one version (`0.1.0`, `0.2.0`, …). An app pins one version for every
  `@cslug/*` dependency, and `cslug about` warns if they differ.
- One `CHANGELOG.md` at the repo root, with sections per package.
- `bun run release <version>` bumps every `package.json` (including peer ranges), runs typecheck and tests,
  and publishes in dependency order (validation → core → … → testing).
- Inside the monorepo, packages reference each other with `workspace:*`.

This is the part strav found painful with 27 packages. Here it is one script over 15 packages that share a
version, so nothing can drift.

## What an app installs

`bun create cslug` writes explicit dependencies for the chosen preset. There is no `cslug` meta-package.

| Preset | Packages |
|---|---|
| `--api` (JSON API) | validation, core, http, database, redis, cli · dev: testing |
| `--web` (default: pages + islands) | api + vue, auth · peer: `vue` |
| `--full` | web + queue, mail, storage |
| add later | `cslug add ai`, `cslug add notification`, `cslug add webhook`: installs the package and adds its provider |

Albastr uses `--full` + notification + webhook. AI is added after the MVP.

## Size budget

Budgets count **lines of code**: no tests, comments or blank lines (`grep -cvE '^\s*(//|\*|/\*\*|\*/)|^\s*$'`).
Doc comments are encouraged, not penalised.

| Package | Lines of code |
|---|---|
| validation | 1,500 |
| core (incl. i18n, contracts) | 2,000 |
| http | 1,800 |
| vue | 1,500 |
| database | 2,500 |
| redis | 400 |
| queue (incl. scheduler) | 1,800 |
| auth | 1,000 |
| mail + notification | 1,200 |
| storage, webhook | 600 |
| ai | 1,000 |
| cli + testing | 1,800 |
| **Total** | **~17,000** |
