# Implementation plan

> **Status (2026-11-27):** approved. Phase 0, the spikes and M1–M12 are done; 0.8.0 released (0.7.x: AJAX forms, two-factor logins in scaffolded apps; 0.8.0: logger targets and request → job origin, `Tracer` / `Metrics` in core, `@cslug/telemetry`). Next: M13–M15 (security, state machine, workflows), planned below.
> Progress is tracked in the status table below. Update it as milestones land.

## Status

| Step | State |
|---|---|
| 0.1 Accounts (npm org, GitHub, `gh`) | ✅ npm org `cslug` (owner `cslugdev`), `create-cslug` claimed; GitHub org `cslugts` (`cslugdev`, `liviathan`) |
| 0.2 `cslug` repository + skeleton + CI + release | ✅ [cslugts/cslug](https://github.com/cslugts/cslug): 15 package skeletons, CI green, graph check, release script, `main` protected |
| 0.3 Pilot app repository | ✅ private: product documents; the app is created from the starter kit at 0.1.0 |
| 0.4 Close spec gaps G1–G18 | ✅ done (folded into `docs/` and `guides/`) |
| S Spikes | ✅ (a) [Vue islands](../spikes/a-vue-islands/README.md) · (b) decorators (verified during design) · (c) [Redis Streams](../spikes/c-redis-streams/README.md) · (d) [async context](../spikes/d-async-context/README.md) |
| M1 validation, core | ✅ `@cslug/validation` (62 tests) · `@cslug/core` (container, providers, config/env, errors, Clock, Money, events, logger, i18n, contracts; 87 tests) |
| M2 database | ✅ Database, sql tag, tables, ambient transactions, query builder, Repository, preload, migrations (concurrent-safe), factories, seeders, idempotent, encrypted columns (49 tests on real PostgreSQL) |
| M3 cli, http, testing (base) | ✅ M3a http core · M3b sessions, CSRF, form errors, throttle, locale · M3c testing base + cli (kernel, `Command` in core, package commands, generators, `migrate*`, `db:seed`, `serve`, `routes`, `start` supervisor, `dev`). Done criteria met on a fixture app (422 shape, SIGTERM drain for `serve` and `start`); the starter kit itself runs from M5. Deferred: `serve --with-worker/--with-scheduler` (M6, queue), `repl`, `describe` (M9) |
| M4 vue | ✅ M4a server rendering (loader, `view()`, islands with serialized props, `<Assets>`, `useRequest`/`useT`/`route`, `renderStandalone`) · M4b browser (`browser` export condition, `mountIslands`, `useT` with ICU from validation, `route`, `useForm` + CSRF, `defineStore`), `Bun.build` with one chunk per island + manifest, `public/` serving, `cslug build`/`typecheck`, dev rebuild + live reload; hydration verified in headless Chrome. Deferred: precompiled server templates, `cslug add tailwind` (plugin wired, untested without the package), nested islands; the starter-kit page check moves to M5 (needs auth) |
| M5 redis, auth → 0.1.0 | ✅ M5a `@cslug/redis` · M5b `@cslug/auth` (session + token guards, `Hash`, `attempt` with throttle and rehash, magic links without a table, API tokens, policies typed from their methods, gates, `auth/guest/ability/can` middleware), `t.actingAs`, group middleware tags in http, package migrations in database. **Released as 0.1.0.** Deferred: TOTP (done after M10: `TwoFactor`, `beginLogin`/`completeTwoFactor`); the starter-kit run (needs queue + mail, M6–M7) |
| M6 queue | ✅ M6a engine: `Job` (tries, backoff, timeout, `failed`, `Job.schema`), dispatch (delay, at, queue, priority bands, unique, held until COMMIT), Redis Streams worker (lease renewal, `XAUTOCLAIM` takeover, graceful stop), failed store, `queue:work/failed/retry/forget/clear/stats`, discovery of `app/jobs` + `app/listeners`, queued listeners, `QueueFake`. Acceptance: rolled-back dispatch never runs ✅, killed worker's job reclaimed ✅. M6b scheduler: own cron parser with time zones, `defineSchedule`, once-per-tick locks, no overlap, `catchUp('once')`, history, `schedule:*`, `t.schedule.runDue()`. Acceptance: two schedulers → one run per tick ✅. M6c: durable outbox (`cslug_queue_outbox`, relayed at COMMIT and by workers), chains, batches, per-queue `rateLimit`, `queue:health`, `serve --with-worker/--with-scheduler`. All three M6 acceptance tests pass |
| M7 webhook, mail → 0.2.0 | ✅ M7a `@cslug/webhook`: `verifySignature` (HMAC, constant time, timestamp tolerance), `WebhookInbox` (exactly once, processors, replay, prune), `webhooks:replay`. Acceptance: webhook delivered 10× (concurrently) → one effect ✅. M7b `@cslug/mail`: mailables on Vue views, CSS inlining, text part, MIME, own SMTP client (STARTTLS, AUTH), Resend/Postmark/Brevo/log/array, queued mail rendered at send time (`cslug.mail`), `mail:preview`, `MailFake`. Acceptance: reminder email received by Mailpit over SMTP ✅ (CI). The starter kit runs end to end (`bun run check:starter`: vue-tsc, feature tests, real processes from register to the reminder email in Mailpit) ✅. **Released as 0.2.0.** |
| M8 notification, storage → 0.3.0 | ✅ M8a `@cslug/storage`: disks (local, S3 through `Bun.s3`, memory), safe keys, `putFile` with the type sniffed from the bytes, signed downloads, direct uploads + `verifyUpload`, local signed URLs served at `/_storage/:disk`, `StorageFake`. S3 tested against RustFS in CI. M8b `@cslug/notification`: `Notification` (`via`, `to<Channel>`), recipients and `recipient()`, messages built in the recipient's locale, mail through the Mailer, `database` channel, `whatsapp`/`sms` with `log` and `manual` drivers, custom channels, one job per delivery, delivery records, `NotificationFake`. **Released as 0.3.0.** |
| M9 ai, create-cslug, extras | ✅ M9a `create-cslug`: presets `--api` / `--web` / `--full` + `--tailwind` from literal template layers, `.env` with a fresh `APP_KEY`, exact lockstep versions; `bun run check:create` scaffolds each preset and typechecks, builds and tests it. M9b `cslug add` (queue, mail, storage, notification, webhook, tailwind): installs at the CLI's version, adds providers and config, idempotent; checked by scaffolding a web app and adding five packages. M9c `cslug describe` (sections contributed by providers: routes, tables, jobs, schedules, providers, config keys) and `cslug repl`. M9d the migration differ: `make:migration --from-tables` and `db:diff` (tables, columns, renames asked, unique/check/foreign-key constraints, indexes; up and down), verified by applying the generated SQL and diffing again. M9e `@cslug/ai` (first part): agents with structured output and tool loops, tools, prompts, streaming + `sse()`, Anthropic (Messages API over `fetch`) and OpenAI-compatible providers, `AiFake`, `cslug add ai`, `ai:prompts`. M9f MCP: `@mcp()` tools served at `POST /mcp` (api middleware, abilities) and by `cslug mcp:serve` (stdio), protocol 2026-07-28 plus the `initialize` versions; `mcp('server').tools()` for agents (HTTP and stdio, discover then initialize). Recorded fixtures (`t.ai.fixture()`, `cslug ai:record`), `cslug ai:eval` (schema failures and diffs), the daily budget (estimated cost per model, shared through the cache, `AiBudgetError` / `AiBudgetAlert`). M9g conversations (1): `history` in, `messages` out (`result()`, `stream().result`), the Anthropic driver caching the conversation. M9g (2) with @cslug/database: `Conversations` / `Conversation` (owner-checked, concurrent turns refused, server-side compaction), `cslug_ai_runs` records. M9h `cslug mcp:dev` (in @cslug/cli, every app: describe, routes, tables, read-only query, logs + last_error from `.cslug/dev.log`, run_test, docs_search), the MCP server protocol moved to core; `cslug agents:sync` (generated AGENTS.md sections between markers, hand-written text kept, `--check` for CI). Next: M10 `@cslug/search` |
| M10 search | ✅ M10a database primitives (generated and hidden columns, index methods and operator classes, `orderBySql` / `selectSql`) and `@cslug/search` full text over tables (`searchable()`: weights, per-row language, accents; `search()`: ranked, highlights, typos); M10b `searchIndex()` (documents in `cslug_search_documents`, ranked paged search, metadata filters) and `cslug search:reindex`; M10c semantic and hybrid search on indexes (pgvector, opt in; `Embedder` contract, `FakeEmbedder`, reciprocal rank fusion; CI on `pgvector/pgvector:pg17`). `@cslug/ai` embedding drivers (`ai.embeddings`: Voyage, OpenAI-compatible; budget; faked in tests). M10d `searchTool()` and conversation recall (`ai.recall`, `recallTool()`, owner-scoped). See [M10](#m10-cslugsearch) |
| M11 logger | ✅ Log targets (stdout, stderr, daily files, custom) with their own level and format, `LOG_LEVEL` / `LOG_FORMAT`, the process role, `originRequestId` from job envelopes, `config/log.ts` in new apps. See [M11–M15](#m11m15-logger-telemetry-security-state-machine-workflows) |
| M12 telemetry | ✅ M12a `Tracer` / `Metrics` contracts in core (no-op by default, `BasicTracer` / `BasicMetrics`, W3C `traceparent`); http, queue, database and ai instrumented. M12b `@cslug/telemetry`: OTLP/HTTP JSON export of traces, metrics and logs (batched, bounded, flushed at shutdown; `OTEL_EXPORTER_OTLP_*`), sampling that keeps failed spans, `/metrics` in Prometheus format (loopback, token or CIDR list), `cslug add telemetry`, guide 23. **→ 0.8.0** |
| M13 security | ⬜ planned (`@cslug/security`) |
| M14 state machine | ⬜ planned (core) |
| M15 workflows | ⬜ planned (`@cslug/workflow`) |

## Context

The cslug spec is complete: `docs/` (principles, decisions D0–D12, packages, architecture, conventions),
`guides/` (00–21), and `apps/starter-kit` (a todo app written against the spec, which surfaced 18 spec gaps,
G1–G18). Nothing is implemented. The goal is to build the framework in an order that gets the **pilot app's MVP**
(kept privately in its own repository) buildable as early as possible, with every step shippable and tested.

Decided with the user:
- **Two repositories.** `cslug`: framework packages, docs, guides, starter kit; public, MIT. The pilot app's repository: the
  product; private; consumes `@cslug/*`.
- **Publishing:** public `@cslug/*` packages on npm, 15 packages in lockstep (docs/packages.md).

Facts checked: no `@cslug/*` package exists yet; the npm org `cslug` is owned by `cslugdev`. `gh` is not installed.
npm is not logged in. The current `bun/` folder is not a git repo.

---

## Phase 0: Accounts, repositories, tooling

### 0.1 Accounts (done by you; needs your identity and 2FA)
1. **npm:** create an account (2FA on). Create the **free org `cslug`**, which also claims the `@cslug` scope. If
   `cslug` is taken, fall back to another org name (for example `cslugjs`) before anything is published.
2. ✅ **GitHub:** org **`cslugts`** (`cslug` was taken by an unrelated organization), owners `cslugdev` and
   `liviathan`; `gh` logged in as `cslugdev`, git pushes over SSH as `liviathan`.
3. ✅ Done. `create-cslug` is published as a placeholder (`0.0.0-stage`), so `bun create cslug` will resolve to it.
   The unscoped name **`cslug` is unavailable**: npm's anti-typosquatting check rejects it as too similar to
   `slug`, `clui` and `tslog`. Not needed: all packages are scoped, and the `cslug` command comes from
   `@cslug/cli`'s `bin`.

### 0.2 The `cslug` repository
- Create `github.com/cslugts/cslug` (public, MIT, default branch `main`, branch protection: PR + green CI).
- Move in from the pilot app's repository: `docs/` (except `docs/proposals/`, which stays private), `guides/`,
  `apps/starter-kit/`. Add `README.md`, `LICENSE` (MIT), `CONTRIBUTING.md`, `CHANGELOG.md`, `AGENTS.md`,
  `CLAUDE.md`.
- Workspace skeleton following docs/directory-structure.md § 2:
  - Root `package.json` (workspaces `packages/*`, `apps/*`; scripts `typecheck`, `lint`, `test`, `release`).
  - `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, standard decorators), `biome.json`,
    `docker-compose.yml` (postgres 17, redis 7, mailpit).
  - Empty `packages/<name>/` for all 15 packages: `src/index.ts`, `tests/`, `docs/README.md`, and a
    `package.json` with `peerDependencies` per docs/packages.md.
- **CI (GitHub Actions):** bun install → biome → typecheck → `bun test` with postgres + redis service
  containers → a **package-graph check** (deps in `package.json` match the graph in docs/packages.md, no deep
  imports, no third-party runtime deps).
- **Release:** `scripts/release.ts` (lockstep bump, peer ranges, publish in dependency order). npm
  **trusted publishing** from a GitHub Actions workflow (OIDC + provenance, no long-lived npm token).
  No placeholders are needed for the scoped packages: owning the `cslug` org reserves every `@cslug/*` name.

### 0.3 The pilot app's repository ✅
- A private repository holds the product app (created later from the starter kit) and `docs/proposals/`.
- During development it consumes the local framework with `bun link` (or a `file:` path). From 0.1.0 on, it
  uses the published versions, so Railway installs from npm with no tokens.

### 0.4 Close the spec gaps before coding ✅
Fold the starter kit's G1–G18 answers into `docs/` and `guides/`: `serialize()`, CSRF for islands, `AuthUser`
augmentation, how configs and route files load, `Hash`, `useForm` verbs, `route()` query, `orderBy` nulls,
`Clock` API, factory API, test helpers, `ability()`. Also fix the tour's island props (G1). The starter kit then
becomes the **acceptance test** for each milestone.

---

## Phase 1: Packages, in the pilot app's MVP order

The MVP build order is (1) operator verification + protected payment, (2) check-ins + offline trip pack,
(3) public pages and forms. The MVP runs many steps by hand (WhatsApp, payouts, document checks), so the
framework must first deliver: **web pages + auth + DB + payment webhook + queue + mail**. Storage,
notifications and AI can wait.

Each milestone = a branch + PR, ending with: tests green, `packages/<name>/docs/README.md` + `api.md` written,
and the matching part of `apps/starter-kit` running for real. `@cslug/testing` grows **with** each package, not
at the end.

| # | Milestone | Packages | Scope | Done when |
|---|---|---|---|---|
| **S** | Spikes (first week, timeboxed) | — | (a) Vue SFC loaded on the server in Bun + `hydrate` → island transform + client mount; (b) standard `@inject(A,B)` typing (already verified on Bun 1.3.14 / TS 7.0.2); (c) Redis Streams via `Bun.redis` `send()` incl. `XAUTOCLAIM` + Lua; (d) ALS overhead per request | Each spike has a throwaway repro and a written yes/no; the riskiest is (a) |
| **M1** | Foundations | `validation`, `core` | `v` + JSON Schema + Standard Schema; container, `@inject`, scopes, tokens, providers (topo boot/rollback/shutdown), `Application`, config + env validation, events, logger (redaction), typed errors, ALS context, `afterCommit` hook, `Clock`, `Money`, i18n (`t`, ICU plurals, `Intl`), contracts + memory drivers | Unit tests; guides 02, 03, 04 and 07 snippets compile |
| **M2** | Data | `database` | **First test: the async context survives `await sql` and `sql.begin()`** (not verifiable in spike d). `Bun.sql` pool, column builders, `Row`/`NewRow`, query builder, `sql` tag, `Repository`, `preload`, ambient transactions + savepoints, `lockForUpdate`, advisory locks, `idempotent`, **SQL-file migrations + runner** (advisory-locked), factories, seeders. **Deferred:** the migration differ (`--from-tables`) | Concurrency tests: two concurrent migrations run once, rollback discards after-commit callbacks |
| **M3** | Running apps | `cli`, `http`, `testing` (base) | CLI kernel, `Command`, packages contribute commands, `make:*` stubs, `migrate*`, `serve`, `dev`, `start` supervisor; router (groups, names, domains, resources), middleware, `HttpContext`, `request.validate`, responses, RFC 9457 + redirect-back errors, sessions (memory), CSRF, `throttle`, health endpoints, graceful shutdown; `testApp()`, HTTP assertions, DB isolation | Starter-kit JSON routes + 422 shape + SIGTERM drain tests pass |
| **M4** | Pages | `vue` | Server loader, `view()`, layouts/slots, islands (`hydrate`, SSR by default, `serialize`), `<Assets>`, `useT/useRequest/useForm/defineStore/route`, `Bun.build` pipeline (Vue, SCSS, optional Tailwind), live reload, `cslug build`, `cslug typecheck` (vue-tsc), `renderStandalone` | Starter-kit todo page renders, islands hydrate, forms work with and without JS |
| **M5** | Users | `redis`, `auth` | Redis connection + drivers (cache, lock, rate limiter, session store); session guard, `Hash`, `attempt`, policies, gates, `ability()`, tokens, magic links | Starter-kit auth flows + policy tests. **→ release 0.1.0**, create the pilot app from the starter kit |
| **M6** | Background work | `queue` | Redis Streams engine, `Job`, retries/backoff/delay/unique, after-commit dispatch, durable outbox, failed store + commands, scheduler (cron, once-per-tick lock, history), worker + scheduler roles in `cslug start` | Acceptance: rolled-back dispatch never runs; killed worker's job reclaimed; two schedulers → one run per tick |
| **M7** | Payments plumbing | `webhook`, `mail` | `verifySignature`, `WebhookInbox` + replay; `Mailer`, `Mailable`, Vue templates, CSS inlining + text part, SMTP client, HTTP transports, `mail:preview` | Webhook replayed 10× → one effect; starter-kit reminder email sent to Mailpit. **→ 0.2.0**: the pilot app's MVP build order (1) unblocked |
| **M8** | MVP completion | `notification`, `storage` | Channels (mail, database, whatsapp/sms with `log` + `manual` drivers), delivery records; disks (local, s3), signed URLs, upload sniffing | The pilot app's check-ins (#7), crisis broadcast (#15), operator documents (#11). **→ 0.3.0** |
| **M9** | After MVP | `ai`, `create-cslug`, extras | Agents, tools, MCP; scaffolder with presets; migration differ; `cslug describe`; AI conversations (M9g); `mcp:dev`, `agents:sync` (M9h) | As needed by the pilot app after its pilot |
| **M10** | Search | `search` | Full-text search over any table (Postgres `tsvector`, per-language configs, ranking, highlights, typo tolerance), an index for arbitrary documents, semantic search with pgvector through an `Embedder` contract, hybrid ranking; used by `@cslug/ai` for retrieval and conversation recall | The pilot app's circuit pages searchable in FR/EN/IT; an agent answers from indexed documents |
| **M11** | Logger | `core` | Log targets (stdout, stderr, file with rotation, custom) with their own level and format; `LOG_LEVEL` / `LOG_FORMAT`; the process role; a job's log lines carry the request that dispatched it; `config/log.ts` in new apps | A request and the job it dispatched share an origin id in the logs |
| **M12** | Telemetry | `telemetry` (+ core contracts) | `Tracer` and `Metrics` contracts in core (no-op by default) used by http, queue, database and ai; OTLP/HTTP export of traces, metrics and logs over `fetch`; `/metrics` in Prometheus format; sampling. **→ 0.8.0** | A collector receives linked spans for request → job → query |
| **M13** | Security | `security` (+ core crypto, auth events) | A `Crypto` service in core with `APP_KEY` rotation; auth events; CSP nonces, account lockout, breached-password check, audit log, IP filter, `security.txt`. **→ 0.9.0** | Old data still decrypts after a key rotation; login and 2FA changes are audited |
| **M14** | State machine | `core` (+ database helper) | `states()` as guide 00 documents (`assert`, `can`, `next`, typed values for `oneOf`) and `repo.transition()` (lock, idempotent, assert, update) | The tour's escrow example runs as written |
| **M15** | Workflows | `workflow` | Durable execution (journaled steps, durable sleeps, waits for events and signals), workflows and sagas (compensations), operations commands and a test fake. **→ 0.10.0** | A run survives a worker crash with no step run twice; a failed saga compensates in reverse once |

### Pilot app track (parallel, from 0.1.0)
- Create the pilot app from the starter kit. Build in MVP order: operator onboarding and booking/escrow states (M5),
  payment webhook + ledger + staged release with manual approval (M6–M7), check-in messages + offline trip
  pack (M7–M8), then circuit pages (FR/EN/IT), the trip request form, proposals and the visa page.
- Any framework change the pilot app needs goes into `cslug` first (PR + release), never patched in the app.

### M9g: AI conversations

Today a run is one exchange: `run({ input, context })` sends one user message, and the tool loop's messages are
dropped when it ends. Two PRs, each merged before the next:

1. **History in and out (no storage).** `run` / `stream` / `result` accept `history: Message[]` and `AiResult`
   returns `messages` (the whole exchange: tool calls, tool results and provider blocks such as thinking, unchanged).
   History is append-only, and the Anthropic driver puts a cache breakpoint on the last message, so each turn reads
   the earlier ones from the prompt cache (a sliding window would invalidate it). Apps store messages wherever they
   like. `AiFake` records the history it was given.
2. **Conversations and run records (with `@cslug/database`, optional).**
   - `ai_conversations` (UUIDv7 id, agent, owner type + id, title, metadata, timestamps) and `ai_messages`
     (conversation id, role, content blocks as `jsonb`, model, usage, created at), as package migrations.
   - `Conversations` service: `start(Agent, { owner })`, `find(id)` (checks the owner against the current user, so
     a conversation is never read by someone else), `chat.send(text)` / `chat.stream(text)` (→ `sse()`),
     `chat.messages()`. The owner is polymorphic, like notification recipients.
   - Long conversations: when the history passes a token limit, the Anthropic driver's server-side compaction, or a
     queued summary of older turns (stored as a message, the originals kept).
   - `ai_runs`: one row per run (agent, conversation, model, steps, usage, estimated cost, status, error): an audit
     trail, spend per owner, and real runs to turn into fixtures.
   - Left out: working memory (an app writes it as a `Tool` over its own repository), semantic recall (comes with
     M10), resumable runs that wait for a human (still deferred).

## M10: @cslug/search

A search package for any text the app holds, not only AI: circuit pages, operators, documents, conversation
messages. Built on Postgres, so an app needs no search server; no third-party runtime dependency.

- **Full text over tables.** A table declares what is searchable and with which weight (`search: { title: 'A',
  summary: 'B', body: 'C' }`) and in which language (a fixed `regconfig` or a column, for FR/EN/IT content). The
  migration differ generates the `tsvector` generated column and its GIN index. Queries compose with the query
  builder: `repo.search('isalo 4x4').where({ published: true }).paginate()`, ranked (`ts_rank_cd`), with
  `websearch_to_tsquery` syntax (quotes, `-word`, `or`), `unaccent`, highlights (`ts_headline`), and `pg_trgm` for
  typos and prefixes.
- **An index for anything else.** `SearchIndex` stores documents that are not rows (files, pages, messages) in one
  table (`search_documents`: index name, key, text, metadata, `tsvector`, optional embedding), with `upsert`,
  `remove`, `search`.
- **Semantic search.** A `vector(n)` column when the `pgvector` extension is installed (otherwise semantic search is
  off and says why). Embeddings come from an `Embedder` contract that `@cslug/search` defines; `@cslug/ai` provides
  drivers (OpenAI-compatible `/embeddings`, Voyage; Anthropic has no embeddings API). Embedding happens in a queued
  job after commit when `@cslug/queue` is installed, inline otherwise.
- **Hybrid ranking.** Full-text and vector results merged with reciprocal rank fusion.
- **Keeping indexes fresh.** Table search needs nothing (generated columns); `SearchIndex` and embeddings are
  updated by the code that writes, plus `cslug search:reindex [index]`.
- **AI use.** A `SearchTool` (an agent searches an index, results with keys and snippets) and conversation recall:
  earlier messages of the owner found by meaning.
- Depends on core, database · optional: queue. `@cslug/ai` ··► search (optional). Engines such as Meilisearch or
  Typesense (over `fetch`) could become drivers later; not in the first version.

## M11–M15: logger, telemetry, security, state machine, workflows

Planned on 2026-11-27, to be built one PR at a time in this order (foundations first). The seven capabilities asked
for (logger, security, observability, state machine, workflow, saga, durable execution) are consolidated: the logger
and the state machine improve `@cslug/core`, and three packages are added (`telemetry`, `security`, `workflow`),
17 → 20 packages. Everything stays free of third-party runtime dependencies (OTLP, Prometheus text, the
breached-password API and CIDR matching are written over `fetch` and Web Crypto). Each new npm package needs a
placeholder publish and its trusted publisher before its first release.

### M11 Logger (core), 1 PR

`Logger` already has levels, JSON or pretty output, redaction, `child()` and the context's `requestId` / `jobId` /
`userId`, but no app configures it and it only writes to stdout.

- `targets`: `stdout` (default), `stderr`, `file` (daily rotation) and custom functions, each with its own level and
  format; `LOG_LEVEL` and `LOG_FORMAT` from the environment.
- Bindings: the process `role` (`CSLUG_ROLE`, set by the supervisor) and, once M12 lands, `traceId` / `spanId`.
- Correlation: a job envelope records its `origin` (the dispatching request id and trace), so a job's lines carry
  `originRequestId`; the scheduler and the CLI likewise.
- `config/log.ts` in `create-cslug` apps and the starter kit (pretty in development, JSON otherwise); guides 06 and
  21 and `docs/architecture.md` brought in line.

### M12 `@cslug/telemetry`, 2 PRs

- **Core contracts first** (contracts in core, drivers in packages): `Tracer` (`span(name, attributes, fn)`,
  `current()`) and `Metrics` (`counter`, `histogram`, `gauge`) bound to no-op versions, so packages instrument
  themselves without importing telemetry:
  - http: a span per request (route, status), W3C `traceparent` in and out, request duration;
  - queue: a producer span at dispatch (its trace saved in the envelope) and a linked consumer span per attempt, job
    duration and failures, queue lag;
  - database: a span per query (statement summary, never values), pool gauges;
  - ai: a span per run and step with model, tokens and estimated cost.
- **The package** binds real implementations: OTLP/HTTP JSON export of traces, metrics and logs (any OpenTelemetry
  collector), batched and flushed at shutdown; `GET /metrics` in Prometheus text format (behind an API token ability
  or an IP list); sampling that keeps errors; exceptions recorded through the error handler's `report()` hook;
  `config/telemetry.ts`, `cslug add telemetry`.
- Depends on core · optional: http, auth.

### M13 `@cslug/security`, 2–3 PRs

Reuses what exists (security headers, CORS, signed URLs, sessions, CSRF, throttling, `Hash`, tokens, policies, TOTP,
column encryption, webhook signatures, trusted proxies, log redaction).

- **Core first:** a `Crypto` service (`encrypt` / `decrypt`, `hmac` / `verifyHmac` in constant time, `random`) used
  by column encryption, signed URLs, magic links and webhooks, which today each carry their own HMAC code. **Key
  rotation:** `APP_KEY` plus `APP_PREVIOUS_KEYS` (new data uses the current key, older data still decrypts and
  verifies); `cslug key:rotate` explains the steps. `@cslug/auth` emits typed events (login succeeded or failed,
  two-factor turned on or off, password changed, token created or revoked).
- **The package:** `csp()` with a per-request nonce (`<Assets>` in `@cslug/vue` adds it to its scripts and styles);
  account lockout after repeated failures (a guard hook in `auth.attempt()`); `notBreached()` for passwords
  (HaveIBeenPwned's k-anonymity API: only 5 characters of a SHA-1 hash leave the server; opt in, fails open); an
  audit log (`cslug_audit_log`, `audit.record()`, auth events recorded automatically, `cslug audit:prune`);
  `ipFilter()` with CIDR ranges, a global per-IP limit, `/.well-known/security.txt`. A dependency audit step in CI.
- Depends on core, http · optional: database, auth, vue, notification.

### M14 State machine (core), 1 PR

- `states(transitions, { name })`: `.values` (for `text().oneOf(…)`), `.type`, `.can(from, to)`, `.next(from)`,
  `.final(state)`, `.assert(from, to)` throwing `ConflictError('<name>.invalid_transition', { from, to })`; optional
  `onEnter` / `onLeave` hooks that run in the caller's transaction.
- `repo.transition(id, 'status', BookingStatus, 'deposit_paid', fn?)` in `@cslug/database`: lock the row, return early
  when it is already there, assert, update and run `fn`, in the ambient transaction (the escrow pattern of guide 00,
  which is corrected to the real signature).

### M15 `@cslug/workflow`, 3 PRs

This reverses the deferral of workflows and durable runs (`docs/decisions.md`, `docs/ai-readiness.md`); the first PR
records the new decision. It is built on the queue (jobs, delayed jobs, the durable outbox), Postgres (transactions,
advisory locks, idempotency) and core events.

- **Durable execution:** `cslug_workflow_runs` and `cslug_workflow_steps`; a workflow is an `@inject()` class with
  `run(ctx, input)`. `ctx.step(name, fn, { tries, backoff, timeout })` journals results, so a resumed run replays
  finished steps from the journal; `ctx.sleep('3d')` / `sleepUntil(date)` are durable timers; `ctx.waitFor(Event,
  match, { timeout })` and signals (`workflows.signal(runId, name, data)`) suspend a run; `ctx.now()` and `ctx.uuid()`
  are journaled. Each resume is one queue job holding a per-run advisory lock. `Workflow.start(input, { id })` is
  idempotent and durable inside a transaction; `find`, `cancel`; versioning rules for changing steps.
- **Sagas:** `ctx.step(name, fn, { compensate })`; on failure the completed steps' compensations run in reverse,
  each journaled and retried (`compensated` / `compensation_failed`).
- **Operations:** `cslug workflow:list|show|retry|cancel|prune`, a `describe` section, telemetry spans per step,
  audit entries, `WorkflowFake` for tests (synchronous runs, fast-forwarded sleeps, delivered signals). Durable AI
  agent runs (an agent step waiting for a person's approval) become possible.
- Depends on core, database, queue.

---

## How each milestone is executed

1. Re-read the relevant guide(s) and `docs/packages.md` rules.
2. Write tests from the guide snippets (they are the spec), then implement until green.
3. Update `packages/<name>/docs/` in the same PR. If the code forced an API change, update the guide in the
   same PR too.
4. Run the starter-kit slice for that milestone (`cslug dev`, then click through).
5. Merge, then at milestone boundaries run `bun run release <version>`.

---

## Verification

- **CI on every PR:** lint, typecheck, unit + integration tests (postgres, redis), the package-graph check.
- **Acceptance tests** (from the original requirements draft), mapped to milestones:
  concurrent release → one release (M2/M6), webhook ×10 → one ledger entry (M7), rolled-back dispatch never
  runs (M6), killed worker reclaimed (M6), two schedulers → one tick (M6), concurrent migrate → once (M2), 422
  shape + 500 with request ID (M3), SIGTERM drain exits 0 (M3/M6).
- **End to end:** the starter kit runs locally (`docker compose up`, `cslug migrate --seed`, `cslug dev`, `bun test`)
  and is deployed to one Railway service with `cslug start` at 0.2.0. Check `/health/ready`, register → todo →
  reminder email.
- **Size budget** (docs/packages.md) checked at each release; a package far over budget gets simplified first.
