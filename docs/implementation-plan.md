# Implementation plan

> **Status (2026-11-26):** approved. Phase 0, the spikes and M1–M5 are done; 0.1.0 is released. Next is milestone M6 (`queue`).
> Progress is tracked in the status table below. Update it as milestones land.

## Status

| Step | State |
|---|---|
| 0.1 Accounts (npm org, GitHub, `gh`) | ✅ npm org `cslug` (owner `cslugdev`), `create-cslug` claimed; GitHub org `cslugts` (`cslugdev`, `liviathan`) |
| 0.2 `cslug` repository + skeleton + CI + release | ✅ [cslugts/cslug](https://github.com/cslugts/cslug): 15 package skeletons, CI green, graph check, release script, `main` protected |
| 0.3 `albastr` repository | ✅ `liviathan/albastr-app` (private): product documents; the app is created from the starter kit at 0.1.0 |
| 0.4 Close spec gaps G1–G18 | ✅ done (folded into `docs/` and `guides/`) |
| S Spikes | ✅ (a) [Vue islands](../spikes/a-vue-islands/README.md) · (b) decorators (verified during design) · (c) [Redis Streams](../spikes/c-redis-streams/README.md) · (d) [async context](../spikes/d-async-context/README.md) |
| M1 validation, core | ✅ `@cslug/validation` (62 tests) · `@cslug/core` (container, providers, config/env, errors, Clock, Money, events, logger, i18n, contracts; 87 tests) |
| M2 database | ✅ Database, sql tag, tables, ambient transactions, query builder, Repository, preload, migrations (concurrent-safe), factories, seeders, idempotent, encrypted columns (49 tests on real PostgreSQL) |
| M3 cli, http, testing (base) | ✅ M3a http core · M3b sessions, CSRF, form errors, throttle, locale · M3c testing base + cli (kernel, `Command` in core, package commands, generators, `migrate*`, `db:seed`, `serve`, `routes`, `start` supervisor, `dev`). Done criteria met on a fixture app (422 shape, SIGTERM drain for `serve` and `start`); the starter kit itself runs from M5. Deferred: `serve --with-worker/--with-scheduler` (M6, queue), `repl`, `describe` (M9) |
| M4 vue | ✅ M4a server rendering (loader, `view()`, islands with serialized props, `<Assets>`, `useRequest`/`useT`/`route`, `renderStandalone`) · M4b browser (`browser` export condition, `mountIslands`, `useT` with ICU from validation, `route`, `useForm` + CSRF, `defineStore`), `Bun.build` with one chunk per island + manifest, `public/` serving, `cslug build`/`typecheck`, dev rebuild + live reload; hydration verified in headless Chrome. Deferred: precompiled server templates, `cslug add tailwind` (plugin wired, untested without the package), nested islands; the starter-kit page check moves to M5 (needs auth) |
| M5 redis, auth → 0.1.0 | ✅ M5a `@cslug/redis` · M5b `@cslug/auth` (session + token guards, `Hash`, `attempt` with throttle and rehash, magic links without a table, API tokens, policies typed from their methods, gates, `auth/guest/ability/can` middleware), `t.actingAs`, group middleware tags in http, package migrations in database. **Released as 0.1.0.** Deferred: TOTP; the starter-kit run (needs queue + mail, M6–M7) |
| M6 queue | ⬜ |
| M7 webhook, mail → 0.2.0 | ⬜ |
| M8 notification, storage → 0.3.0 | ⬜ |
| M9 ai, create-cslug, extras | ⬜ |

## Context

The cslug spec is complete: `docs/` (principles, decisions D0–D12, packages, architecture, conventions),
`guides/` (00–21), and `apps/starter-kit` (a todo app written against the spec, which surfaced 18 spec gaps,
G1–G18). Nothing is implemented. The goal is to build the framework in an order that gets the **Albastr MVP**
(kept privately in the `albastr` repo) buildable as early as possible, with every step shippable and tested.

Decided with the user:
- **Two repositories.** `cslug`: framework packages, docs, guides, starter kit; public, MIT. `albastr`: the
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
- Move in from `albastr/src/bun`: `docs/` (except `docs/proposals/`, which stays private with Albastr), `guides/`,
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

### 0.3 The `albastr` repository ✅
- Private repo **`liviathan/albastr-app`** (`liviathan/albastr` was already taken by the product's business-documents project). Holds the product app (created later from the starter kit) and `docs/proposals/`.
- During development it consumes the local framework with `bun link` (or a `file:` path). From 0.1.0 on, it
  uses the published versions, so Railway installs from npm with no tokens.

### 0.4 Close the spec gaps before coding ✅
Fold the starter kit's G1–G18 answers into `docs/` and `guides/`: `serialize()`, CSRF for islands, `AuthUser`
augmentation, how configs and route files load, `Hash`, `useForm` verbs, `route()` query, `orderBy` nulls,
`Clock` API, factory API, test helpers, `ability()`. Also fix the tour's island props (G1). The starter kit then
becomes the **acceptance test** for each milestone.

---

## Phase 1: Packages, in Albastr MVP order

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
| **M5** | Users | `redis`, `auth` | Redis connection + drivers (cache, lock, rate limiter, session store); session guard, `Hash`, `attempt`, policies, gates, `ability()`, tokens, magic links | Starter-kit auth flows + policy tests. **→ release 0.1.0**, create the `albastr` app from the starter kit |
| **M6** | Background work | `queue` | Redis Streams engine, `Job`, retries/backoff/delay/unique, after-commit dispatch, durable outbox, failed store + commands, scheduler (cron, once-per-tick lock, history), worker + scheduler roles in `cslug start` | Acceptance: rolled-back dispatch never runs; killed worker's job reclaimed; two schedulers → one run per tick |
| **M7** | Payments plumbing | `webhook`, `mail` | `verifySignature`, `WebhookInbox` + replay; `Mailer`, `Mailable`, Vue templates, CSS inlining + text part, SMTP client, HTTP transports, `mail:preview` | Webhook replayed 10× → one effect; starter-kit reminder email sent to Mailpit. **→ 0.2.0**: Albastr MVP build order (1) unblocked |
| **M8** | MVP completion | `notification`, `storage` | Channels (mail, database, whatsapp/sms with `log` + `manual` drivers), delivery records; disks (local, s3), signed URLs, upload sniffing | Albastr check-ins (#7), crisis broadcast (#15), operator documents (#11). **→ 0.3.0** |
| **M9** | After MVP | `ai`, `create-cslug`, extras | Agents, tools, MCP; scaffolder with presets; migration differ; `cslug describe`, `mcp:dev`, `agents:sync` | As needed by Albastr post-pilot |

### Albastr track (parallel, from 0.1.0)
- Create `albastr` from the starter kit. Build in MVP order: operator onboarding and booking/escrow states (M5),
  payment webhook + ledger + staged release with manual approval (M6–M7), check-in messages + offline trip
  pack (M7–M8), then circuit pages (FR/EN/IT), the trip request form, proposals and the visa page.
- Any framework change Albastr needs goes into `cslug` first (PR + release), never patched in the app.

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
