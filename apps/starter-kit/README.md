# cslug starter kit: todos

A small todo app that exercises most of cslug. It is what `bun create cslug` should generate, plus one feature.

> **Status: spec check, not runnable yet.** The `@cslug/*` packages do not exist, so `bun install` fails on the
> `workspace:*` dependencies, and the app is not in the root workspace list. It installs 10 of the 15 packages
> (no ai, notification, storage or webhook), which shows the granular setup. Every file is written against the
> documented API in `docs/` and `guides/`. Writing it surfaced the gaps listed at the end, which are now resolved in
> the docs.

## What it covers

| Feature | Where | cslug module |
|---|---|---|
| Register / login / logout (sessions, CSRF, throttling) | `app/controllers/auth/`, `resources/views/auth/` | http, auth, validation |
| Todo CRUD, owner-only (policy) | `todo-controller.ts`, `todo-policy.ts` | http, auth |
| Typed table, repository, builder + tagged SQL | `app/tables/`, `app/repositories/` | db |
| Transaction + row lock + event | `todo-service.ts` → `TodoCompleted` | db, core events |
| Synchronous listener + cache | `forget-todo-stats-listener.ts` | cache |
| Server-rendered Vue page with two kinds of islands | `resources/views/todos/index.vue`, `resources/components/` | vue |
| Forms with and without JavaScript | `login.vue` (plain), `new-todo-form.vue` (island + `useForm`) | http, vue |
| Daily reminder email | `routes/schedule.ts` → `send-due-reminders-job.ts` → `todo-due-mail.ts` | schedule, queue, mail |
| Token API + transformer | `routes/api.ts`, `controllers/api/`, `transformers/` | http, auth |
| CLI command | `purge-completed-todos-command.ts` (`cslug todos:purge --days=90`) | cli |
| i18n (en, fr), ICU plurals | `resources/lang/` | i18n |
| Factories, seeder, feature tests | `database/`, `tests/` | testing |
| Single-instance deploy | `railway.json`, `Dockerfile` (`cslug start`) | cli |

## Run it (once cslug exists)

```bash
docker compose up -d
cp .env.example .env && cslug key:generate
cslug migrate --seed           # demo@example.test / password-password
cslug dev                      # http://localhost:3000, Mailpit on :8025
bun test
cslug typecheck
```

## Layout

```
app/
  controllers/      home-controller.ts, todo-controller.ts, auth/…, api/api-todo-controller.ts
  validators/       register-validator.ts, login-validator.ts, store-todo-validator.ts, update-todo-validator.ts
  policies/         todo-policy.ts
  services/         todo-service.ts
  repositories/     user-repository.ts, todo-repository.ts
  tables/           user-table.ts, todo-table.ts
  events/           todo-completed.ts
  listeners/        forget-todo-stats-listener.ts
  jobs/             send-due-reminders-job.ts
  mail/             todo-due-mail.ts
  commands/         purge-completed-todos-command.ts
  providers/        app-service-provider.ts
  transformers/     todo-transformer.ts
bootstrap/          app.ts, providers.ts
config/             env.ts, app.ts, http.ts, database.ts, redis.ts, cache.ts, queue.ts, mail.ts, session.ts, auth.ts, i18n.ts, index.ts
database/           migrations/*.sql, factories/, seeders/
resources/
  views/            layouts/default.vue, auth/login.vue, auth/register.vue, todos/index.vue, errors/404.vue
  components/       new-todo-form.vue, todo-item.vue        (islands where used with `hydrate`)
  mail/             layout.vue, todo-due.vue
  styles/           app.scss, _tokens.scss
  lang/             en.json, fr.json
  client.ts
routes/             web.ts, api.ts, schedule.ts
tests/              feature/*.test.ts, unit/*.test.ts
```

## Spec gaps found while writing this (resolved)

All 18 answers below have been folded into `docs/` and `guides/` (plan step 0.4). The table is kept as a
record of what writing a real app revealed.

| # | Gap | Proposed answer |
|---|---|---|
| G1 | **Passing real rows to an island.** A view has `Todo` (with `Date`), while the island prop is `Serialized<Todo>`. vue-tsc rejects `:todo="todo"`, and the tour has the same problem with `bigint`. | Add `serialize(row)` to `@cslug/vue`, returning `Serialized<T>`, and use it in views (`:todo="serialize(todo)"`). The island transform still serialises at runtime; `serialize` only fixes the type. Used in `todos/index.vue`. |
| G2 | **CSRF for island `fetch` calls.** `useRequest()` is server-only, so an island cannot read the token. | `<Assets>` emits `<meta name="csrf-token">`, and `useForm()` sends it as `X-CSRF-Token` automatically. |
| G3 | **Typing `auth.user()`.** Nothing says how the framework learns the app's `User` type. | Module augmentation: `declare module '@cslug/core' { interface AuthUser extends User {} }` in `config/index.ts`. The repository comes from `config/auth.ts` → `users: UserRepository`. |
| G4 | **How config reaches the app.** Guide 04 types `config()`, but never shows where `configs` is loaded. | `new Application({ root, configs })` in `bootstrap/app.ts`. |
| G5 | **How route files are loaded.** Implicit. | Convention: `HttpProvider` loads `routes/web.ts` (web group) and `routes/api.ts` (api group); `ScheduleProvider` loads `routes/schedule.ts`. Document it in guide 05. |
| G6 | **Hashing a password at registration.** `auth.attempt()` verifies, but no API creates a hash. | `Hash` service in `@cslug/auth`: `hash.make()`, `hash.verify()`, `hash.needsRehash()`. Used in `register-controller.ts`. |
| G7 | **Flash messages are translated twice.** Controllers flash `t('…')` text, while guide 08's layout calls `t(message)` again. | Flash holds final text; the layout prints `{{ message }}`. Guide 08 is fixed. |
| G8 | **`useForm` without fields, other verbs, response.** For toggle and delete buttons. | `useForm({})`, plus `form.post/put/patch/delete(url)` → `Promise<boolean>`, and typed `form.response`. |
| G9 | **Query strings in `route()`.** | `route(name, params, { query: { filter: 'open' } })`. |
| G10 | **Ordering with NULLs, several `orderBy`s.** | `.orderBy(col, dir, { nulls: 'first' \| 'last' })`, chainable. Add to guide 09. |
| G11 | **Clock helpers.** The app needed `today()`, `today(-3)`, `now()` and `subtract('90d')`. | Document the `Clock` API in core: `now()`, `today(offsetDays?, tz?)`, `add(duration)`, `subtract(duration)`, `atLocal(date, time, tz)`. |
| G12 | **Factory helpers.** `fake.passwordHash()`, states as functions of `{ clock }`, `.for({ userId })`. | Add to guide 09: `state(name, values \| (ctx) => values)` and `.for(attrs)`. |
| G13 | **`defineOptions({ lang })`** for island translations is a custom option. | `@cslug/vue` augments Vue's `ComponentCustomOptions` so vue-tsc accepts it. |
| G14 | **`ability()` middleware** is used in guide 15's prose but missing from guide 05's middleware table. | Add `ability('x:y')` to the built-in middleware table. |
| G15 | **Test helpers** needed beyond guide 19: `assertOldInput`, `assertDontSee`, `assertQueuedCount`, `app.auth.check()`, `app.tokens.create()`, `app.db.find()`. | Add them to guide 19. |
| G16 | **Where `defineCslugConfig` comes from.** | `import { defineCslugConfig } from '@cslug/core'`. |
| G17 | **`v.coerce.*` and `v.secret()`.** Used for env and checkbox inputs; only partially documented. | List them in guide 07 (`v.coerce.int/boolean/date`, `v.secret()`). |
| G18 | **Listener with `@inject(...)` + `@listener(...)`.** Two class decorators; their order needs to be defined. | Order doesn't matter; both write to the same class registry. State it in guide 13. |
