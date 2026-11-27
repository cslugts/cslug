# Changelog

All `@cslug/*` packages share one version (lockstep). Entries are grouped by package.

## Unreleased

## 0.7.0 (2026-11-27)

Forms without page reloads in `@cslug/vue`: `useForm` callbacks and progressive enhancement, an `http` client, live
validation (in the browser and against the route), and API routes callable from the app's own pages with the session.

### @cslug/vue
- `useForm(initial, callbacks)`: Inertia-style callbacks (`onBefore`, `onStart`, `onProgress`, `onSuccess`,
  `onError`, `onCancel`, `onFinish`, on the form and per call); `form.submit(event)` reads the `<form>`'s action and
  method, so a plain form is enhanced after hydration; a server `redirect()` is followed; `cancel()`, `isDirty`,
  `hasErrors`, `wasSuccessful`, `recentlySuccessful`, `progress`, `transform`, `setError`, `reset(...fields)`,
  `defaults()`; `File` values are sent as multipart with upload progress.
- `http.get/post/put/patch/delete`: requests that are not forms, with the same CSRF, JSON and error handling.
- Live validation: `form.validate(field, $event?)` checks fields in the browser with the server's `v` schema
  (`schema`), on the server with a validate-only request (`validate: 'server'`, debounced, files left out), or both;
  `validating`, `touched`, `touch`, `valid`, `invalid`.

### @cslug/http
- `redirect()` answers `204` + `X-Cslug-Redirect` to requests from `useForm` / `http` (`X-Cslug-Request: 1`), so
  one controller serves plain forms and islands.
- `http.api.stateful` (and `statefulApi()`): requests from the app's own pages (Origin, Referer or
  `Sec-Fetch-Site: same-origin`) get the session and CSRF on `routes/api.ts`, so islands call API routes as the
  signed-in user; other clients keep API tokens.
- `.validates(schema)` on a route: validate-only requests (`X-Cslug-Validate`) run its middleware and that schema,
  answer 204 or 422 for the asked fields, and never call the handler.

## 0.6.1 (2026-11-27)

TOTP two-factor authentication in `@cslug/auth`.

### @cslug/auth
- Two-factor authentication (TOTP, RFC 6238): `TwoFactor` (`enable` → secret + `otpauth://` URI, `confirm` →
  recovery codes, `verify`, `disable`, `regenerateRecoveryCodes`), stored in `cslug_two_factor` (secret encrypted,
  recovery codes hashed, no code accepted twice). `auth.attempt()` and the new `auth.beginLogin(user)` leave a 2FA
  user waiting for `auth.completeTwoFactor(code)` (`auth.twoFactorPending`); failed codes are throttled.

## 0.6.0 (2026-11-27)

`@cslug/search`: full-text search over any table and document indexes on PostgreSQL, multilingual and
accent-insensitive, with semantic and hybrid search through pgvector; embedding drivers and search tools for agents
in `@cslug/ai`; generated and hidden columns and index methods in `@cslug/database`.

### @cslug/search (new)
- `searchable(weights, { language, unaccent })`: a hidden generated `tsvector` column, weighted `A`–`D`, in one
  language or one per row (a language column), accent-insensitive through `cslug_<config>` configurations.
- `search(repoOrQuery, term, options)`: ranked web-search queries (phrases, `-without`, `or`), HTML-safe highlights,
  typo tolerance (pg_trgm), per-language queries; composes with `where` and `paginate`.
- `SearchProvider` and its migration (`unaccent`, `pg_trgm`, the configurations); `cslug add search`.
- `searchIndex(name, { languages, documents })`: documents that are not rows, in `cslug_search_documents`
  (`upsert`, `remove`, `clear`, ranked `search` with metadata filters, highlights and typos, as a page);
  `cslug search:reindex [index]` refills indexes from their source and removes stale documents;
  `removeWhere(metadataFilter)`.
- Semantic and hybrid search: `searchIndex(name, { semantic: true })` embeds documents on upsert (only when their
  text or the model changed) with the app's `Embedder`, into `cslug_search_embeddings` (pgvector, opt in with
  `search.vectors: true`); `search(term, { mode: 'semantic' | 'hybrid', minSimilarity })`, hybrid by reciprocal
  rank fusion. `Embedder` contract and `FakeEmbedder`. `cslug add search` writes `config/search.ts`.

### @cslug/database
- Generated columns: `.generatedAs((c) => sql)` (`generated always as (…) stored`), never written by inserts or
  updates; the differ creates them and follows expression changes (`set expression`, PostgreSQL 17+).
- Hidden columns: `.hidden()` keeps a column out of selects and `Row`. `custom<T>(sqlType)` for any type.
- Indexes with an access method and operator classes: `t.using('gin', 'search')`,
  `t.using('gin', ['name', 'gin_trgm_ops'])`, created and compared by the differ.
- Query: `orderBySql(sql)` and typed computed values with `selectSql(name, sql)`.

### @cslug/ai
- Search tools: `searchTool(index, options)` lets an agent search a `@cslug/search` index (plain-text snippets);
  `ai.recall` keeps stored conversations' messages in an index and `recallTool()` searches the current owner's
  earlier conversations only. Agents' `tools` accept tool objects.
- Embeddings: `ai.embeddings` (`voyage` with `input_type` per purpose, or any `openai-compatible` `/embeddings`)
  binds @cslug/search's `Embedder`; calls are charged to the daily budget; `fakes: ['ai']` swaps it for a
  `FakeEmbedder`.
- Prompts: `{{ trip.circuit.name }}` reads nested values, objects and lists are written as JSON, and
  `{{ language | English }}` gives a default; `ai:prompts` marks variables with a default (`language?`).
- `instructions` can be a function of the run's context (sync or async) returning a string or a `prompt(...)`.

## 0.5.0 (2026-11-27)

`@cslug/ai`: agents, tools, MCP, conversations, fixtures and evals, a daily budget; and two tools for coding agents
in every app, `cslug mcp:dev` and `cslug agents:sync`.

### @cslug/cli
- `cslug mcp:dev`: a development MCP server (stdio) for coding agents, in every app: `describe`, `routes`,
  `tables`, `query` (read-only), `logs`, `last_error`, `run_test`, `docs_search`. Refused in production.
- `cslug dev` also writes what its processes print to `.cslug/dev.log` (JSON lines), which `mcp:dev` reads.
- `cslug agents:sync`: writes the generated sections of AGENTS.md (packages and docs, rules, folders, commands,
  routes and tables, tools) between markers, keeping the hand-written text; `--check` for CI.

### @cslug/core
- The MCP server protocol moves here (`handleMcpMessage`, `serveMcpStdio`, `McpTool`, `MCP_VERSIONS`), shared by
  `@cslug/ai` and `cslug mcp:dev`; `@cslug/ai`'s `handleMcp` and `MCP_VERSIONS` are unchanged.

### @cslug/ai
- MCP: `@mcp()` exposes tools at `POST /mcp` (streamable HTTP, API-token abilities, Origin checked) and with
  `cslug mcp:serve` (stdio); protocol 2026-07-28 and the `initialize` versions back to 2025-03-26.
  `mcp('server').tools([...])` gives an agent another server's tools (HTTP or stdio).
- `Agent` (`model` or a role, `instructions`, `output`, `tools`, `maxSteps`, `effort`): `run()` with structured output
  parsed and validated by the `v` schema, a tool loop (inputs validated, errors returned to the model), `stream()`.
- `Tool`, `prompt()` (Markdown files with `{{ variables }}`), `sse()` for streaming to the browser.
- Providers over `fetch`: Anthropic Messages API (prompt caching, structured output, server-side refusal
  fallbacks, streaming with tool use) and OpenAI-compatible chat completions.
- `fakes: ['ai']` → `t.ai` (`respond`, `assertRan`); `cslug add ai`; `cslug ai:prompts`.
- Recorded fixtures: `t.ai.fixture(Agent, 'name')` replays `tests/fixtures/ai/name.json`; `cslug ai:record` runs
  tests against the real provider and writes the missing ones (`--all` re-records); `cslug ai:eval [folder]` runs them
  through the real model and reports schema failures and diffs.
- Daily budget: `ai.budget: { perDay: { usd }, alertAt }`, each call charged at the model's estimated price (cache
  reads and writes included), kept in the cache; `AiBudgetError` once spent, `AiBudgetAlert` event at `alertAt`.
  `ai.result()` gives a run's raw answer, usage and cost.
- Conversations: `run` / `result` / `stream` take `history` (a previous result's `messages`) and results return
  `messages`, tool rounds and provider blocks included. `stream()` returns an `AiStream` whose `result` settles
  once read. The Anthropic driver caches the conversation automatically after the system prompt.
- Stored conversations with @cslug/database: `Conversations` (`start`, owner-checked `find`, `list`) and
  `Conversation` (`send`, `stream`, `messages`, `update`, `delete`), with concurrent turns refused (409) and
  server-side compaction on the models that have it (`compact` agent setting). Every run is recorded in
  `cslug_ai_runs` (tokens, estimated cost, status; `ai.runs: false` to turn off). `cslug add ai` mentions
  `cslug migrate`.

## 0.4.1 (2026-11-27)

Apps created with `bun create cslug` type-check out of the box.

### @cslug/testing
- Fix: an app that does not install every optional package (an `--api` app without vue, a `--web` app without
  queue or mail) failed `typecheck` with "Cannot find module" inside `@cslug/testing`. The optional packages' types
  now come from a `.d.ts` (which `skipLibCheck` lets degrade to `any`) and their runtime imports from
  `importOptional()`.

### Tooling
- `bun run check:create` installs the packages into each scaffolded app as npm does (copied, without the
  repository's dev dependencies) and runs the app's own `cslug`, so a missing optional package is caught.

## 0.4.0 (2026-11-27)

Starting and growing an app (milestone M9, first part): `bun create cslug`, `cslug add`, `describe`, `repl`, the
migration differ and `db:shell`.

### @cslug/database
- `cslug db:shell [-c sql]`: `psql` on the app database, the password through `PGPASSWORD`.
- The table differ: `cslug make:migration --from-tables` writes the SQL that brings the database to `app/tables/`
  (up and down; renames asked; data-losing changes flagged with `-- review:`), `cslug db:diff` shows it.
  `loadTables`, `tableSpec`, `introspect`, `diffSchemas`, `renameCandidates`, `migrationSql`.

### @cslug/cli
- `cslug describe [section] [--json]`: routes, tables, jobs, schedules, providers, config keys; providers contribute
  sections with `this.describe(name, fn)` (core: `DESCRIBE`, `DescribeSection`, `app.providers`).
- `cslug repl`: TypeScript, top-level `await`, declarations kept between lines, tables and repositories in scope.
- `cslug add <names>` (`queue`, `mail`, `storage`, `notification`, `webhook`, `tailwind`): installs the packages at
  the CLI's version, adds their providers and config files, the worker and scheduler for `queue`; idempotent.

### create-cslug
- `bun create cslug <dir>` with presets `--api`, `--web` (default) and `--full`, plus `--tailwind`; writes `.env`
  with a fresh `APP_KEY`, pins every `@cslug/*` package to the release version, runs `bun install` and `git init`.
- Each preset is checked in CI: scaffolded, typechecked, built and tested (`bun run check:create`).

## 0.3.0 (2026-11-27)

The MVP's remaining packages (milestone M8): storage and notifications.

### @cslug/notification
- `Notification` (`via(to)`, `to<Channel>(to)`) and `Notifier.send` / `sendMany`; recipients are any object
  (`recipient(row, fn)` for explicit routes); messages are built in the recipient's locale.
- Channels: `mail` (through the Mailer, queued), `database` (`cslug_notifications`), `whatsapp` and `sms` with `log`
  and `manual` drivers, custom channels with `extend()`.
- One job per delivery (`cslug.notification`), after COMMIT; delivery records in `cslug_notification_deliveries`.
- `fakes: ['notify']` → `t.notify` (`assertSentTo`, `assertNotSentTo`, `assertNothingSent`).

### @cslug/mail
- `mailer.to(…).queue(mailable)`: queued even if the mailable is not.

### @cslug/storage
- `Storage` with `local`, `s3` (`Bun.s3`, any S3-compatible service) and `memory` disks from `config/storage.ts`.
- `putFile(dir, file)`: generated `dir/<uuidv7>.<ext>` key, extension from the sniffed bytes; keys can never leave
  the disk.
- `signedUrl` (with `download` file name) and `signedUploadUrl` + `verifyUpload` for direct browser uploads; on a
  local disk the app serves them at `/_storage/:disk`.
- `fakes: ['storage']` → `t.storage` (`assertExists`, `assertMissing`).

### @cslug/core
- Re-exports `sniffType` and `parseSize` from validation.

## 0.2.0 (2026-11-27)

Background work and email (milestones M6–M7): queue and scheduler, webhooks, mail; the starter kit runs end to
end.

### @cslug/queue
- `Job` with typed payloads, `tries`, `backoff` (`Job.exponential`), `timeout`, `failed()`, `Job.schema()`.
- `dispatch()` with `delay`, `at`, `onQueue`, `priority` (three bands), `unique`, `tries`, `immediately`; held until
  COMMIT inside a transaction and dropped on rollback.
- Redis Streams engine: consumer groups, delayed set promoted in Lua, atomic ack/retry/fail, lease renewal while a
  job runs, takeover of a dead worker's jobs (`XAUTOCLAIM`), graceful stop on SIGTERM.
- Failed store with retention; `queue:work`, `queue:failed`, `queue:retry`, `queue:forget`, `queue:clear`,
  `queue:stats`; workers discover `app/jobs/` and `app/listeners/`.
- Queued `@listener`s run as jobs.
- Scheduler: `defineSchedule` in `routes/schedule.ts`, own cron parser with time zones, frequency helpers and
  filters, once-per-tick locks across instances, no overlap, `catchUp('once')`, run history; `schedule:work`,
  `schedule:run`, `schedule:list`, `schedule:history`, `schedule:test`.
- `.durable()`: the outbox table `cslug_queue_outbox` (when `@cslug/database` is installed), relayed at COMMIT and by
  workers. `Queue.chain()`, `Queue.batch().then().allowFailures()`, `Job.with()`. Per-queue `rateLimit`.
  `queue:health`.

### @cslug/mail
- `Mailable` (`subject`, `view`, `html`, `text`, `attach`, …), rendered in the recipient's locale: Vue views through
  `renderStandalone`, CSS inlined (HTMLRewriter, specificity order), text part derived, MIME with attachments.
- `Mailer.to(…).locale(…).send()` / `sendNow()`; queued mail is rendered at send time and queued as `cslug.mail`
  (after COMMIT); without the queue it is sent after COMMIT in-process.
- Transports: own SMTP client (STARTTLS, implicit TLS, AUTH PLAIN/LOGIN), Resend, Postmark, Brevo, log, array.
- `cslug mail:preview` (mailables with `static preview()`); `MailFake` for `fakes: ['mail']`.
- The text part drops hidden preheader text and breaks lines at block openings too.

### @cslug/vue
- The `.vue` loader accepts several app roots in one process (test suites); each file compiles against its own.
- `onView()` hook; `useRequest().user` typed as `AuthUser | null`; asset build errors say which file made the import.

### Starter kit
- Runs: typechecks with `vue-tsc`, 14 feature tests, and an end-to-end test in real processes (migrate, build,
  `cslug start`, register, add a todo, run the reminder, the email arrives in Mailpit). `bun run check:starter`.

### Code quality
- `@cslug/http`: `Session.available` (false on the placeholder of a route without `session()`), used by auth and
  vue instead of comparing class names.
- `@cslug/auth`: its dependencies are registered in the container (no property on the application object);
  `UserSource` declares the optional `update()` it uses to store a rehashed password.
- Doc comments on the exports whose behaviour is not obvious from their name.

### @cslug/testing
- `t.auth.check()` / `t.auth.user()`, `t.tokens.create()`, `assertView(View, fn)`, `assertIsland(name, props)`.
- Fakes listed in `testApp({ fakes })` are typed as present; `.json()` writes carry the CSRF token like an
  island; `t.db.count/assertDatabaseHas` accept `@cslug/database` operators.

### @cslug/auth
- `gate` shortcut (`gate.define(…)`, as in guide 15) and `userSource(app)`.

### @cslug/webhook
- `verifySignature(name | fn)`: HMAC (sha1/256/512) over the raw body, constant-time comparison, `{timestamp}`
  formats with a tolerance; `signWebhook()` for tests.
- `WebhookInbox`: exactly-once receipt (`cslug_webhook_inbox`, insert on conflict do nothing in a transaction),
  `process()`, `payload()` with validation, `replay()` (`cslug webhooks:replay`), `prune()`.

### @cslug/http
- `cslug serve --with-worker --with-scheduler`: the queue worker and the scheduler in the web process.

### @cslug/database
- `Migrator` option `packageMigrations` (default: the folders added with `addMigrations()`).

### @cslug/testing
- `fakes: ['queue']`: `QueueFake` with `assertPushed`, `assertNotPushed`, `assertPushedCount`, `assertNothingPushed`
  and `drain()`.
- `t.schedule.runDue()`: run what is due at the fake clock's time.

## 0.1.0 (2026-11-26)

First release: web apps with pages, auth and PostgreSQL (milestones M1–M5). Packages are published as
TypeScript source for Bun ≥ 1.3.14.

### @cslug/validation
- Schemas and validators with a Zod-like API and no dependencies.
- Every schema implements Standard Schema and exports JSON Schema.

### @cslug/core
- `Application`, the container with standard `@inject(A, B)`, scopes and tokens.
- Service providers with topological boot, rollback and shutdown.
- The ambient context on `AsyncLocalStorage`, with `afterCommit` hooks.
- Config and env validation, typed errors, `Clock`, `Money` (bigint minor units).
- Events, the logger with redaction, and i18n (`t`, ICU plurals, `Intl`).
- `Cache` / `Lock` / `RateLimiter` / `SessionStore` contracts with in-memory drivers, and `Command`.

### @cslug/database
- PostgreSQL on `Bun.sql`: typed tables, the `sql` tag, ambient transactions with savepoints,
  `lockForUpdate`, advisory locks.
- The single-table query builder, `Repository`, `preload`, pagination.
- SQL-file migrations with an advisory-locked runner (concurrent `migrate` runs once), plus package migrations.
- Factories, seeders, `idempotent()`, encrypted columns.

### @cslug/http
- Router (groups, names, domains, resources), middleware with group tags, `HttpContext`, `request.validate`,
  responses.
- RFC 9457 errors with request IDs, and redirect-back with form errors and old input.
- Sessions, CSRF, `throttle`, locale detection, health endpoints, graceful shutdown on `Bun.serve`.

### @cslug/testing
- `testApp()` with requests that need no port, HTTP assertions, and per-test DB isolation (rollback or
  truncate).
- `t.actingAs`.

### @cslug/cli
- The `cslug` binary and kernel. Packages can contribute commands.
- `make:*` generators, `key:generate`.
- `migrate*`, `db:seed`, `routes`.
- `serve`, `dev`, and the `start` supervisor, with SIGTERM drain.

### @cslug/vue
- Server rendering: the `.vue` loader, `view()` with layouts and slots, and islands with serialized props.
- `<Assets>`, `renderStandalone`, and the `useRequest` / `useT` / `route` composables.
- In the browser: `mountIslands`, `useForm` with CSRF, and `defineStore`.
- `Bun.build` with one chunk per island plus a manifest, and `public/` serving.
- `cslug build` and `cslug typecheck`, with dev rebuild and live reload.
- `hydrate="idle"` islands hydrate when the browser is idle, or after 2 s at the latest.

### @cslug/redis
- Connections on `Bun.redis`, a Lua script helper, and Redis drivers for `Cache`, `Lock`, `RateLimiter` and
  `SessionStore`.

### @cslug/auth
- Session and token guards, `Hash`, and `attempt` with throttling and rehash.
- Magic links (no table needed) and API tokens.
- Policies typed from their methods, gates, and the `auth` / `guest` / `ability` / `can` middleware.

### Not implemented yet
`@cslug/queue`, `@cslug/webhook`, `@cslug/mail`, `@cslug/notification`, `@cslug/storage` and `@cslug/ai`
are published as empty placeholders to keep the lockstep version. They arrive in 0.2.0 (queue, webhook, mail),
0.3.0 (notification, storage) and later (ai).
