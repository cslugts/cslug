# Getting started

## Requirements

Bun ≥ 1.3.14, and PostgreSQL 17 and Redis 7. The generated `docker-compose.yml` runs both (and Mailpit, which catches
outgoing mail, with `--full`); a local install works too.

## Create an app

```bash
bun create cslug my-app             # the default preset: --web
cd my-app
docker compose up -d                 # postgres, redis (and mailpit with --full)
bunx cslug migrate                   # .env was written with a fresh APP_KEY
bunx cslug dev                       # the web process with live reload and HMR; workers too with --full
```

| Preset | Installs | Gives you |
|---|---|---|
| `--api` | core, validation, http, database, redis, cli · dev: testing | `routes/api.ts` with `/api/v1/hello`, config, a feature test |
| `--web` (default) | `--api` + vue, auth · `vue`, `sass`, `vue-tsc` | A home page, register / log in / log out (two-factor ready), a dashboard behind `auth()`, the `users` table, factory and seeder, a layout and styles, auth tests |
| `--full` | `--web` + queue, mail, storage | A worker and the scheduler, `routes/schedule.ts`, mail config and a queued `WelcomeMail` with a Vue template, storage config, Mailpit |
| `--tailwind` (with any) | `tailwindcss`, `bun-plugin-tailwind` | Tailwind 4 through the asset build |

Every `@cslug/*` package is pinned to one version: the packages of a release are released together. Add more later
with `cslug add` (guide 20): `cslug add queue,mail`, `cslug add search`, `cslug add ai`.

The app's scripts: `bun run dev`, `start`, `build`, `typecheck`, `test` and `lint` (Biome). `bunx cslug <command>`
runs any command; `cslug list` shows them all.

## The project

```
my-app/
├── app/
│   ├── controllers/        # home-controller.ts, auth/session-controller.ts, …
│   ├── repositories/       # user-repository.ts
│   ├── tables/             # user-table.ts: the users table, typed
│   ├── validators/         # login-validator.ts, register-validator.ts
│   └── providers/          # app-service-provider.ts: your own wiring
├── bootstrap/
│   ├── app.ts              # createApp(): the Application with its config and providers
│   └── providers.ts        # one provider per installed package, then yours
├── config/                 # env.ts (validated env vars), app.ts, database.ts, http.ts, session.ts, auth.ts, …
├── database/
│   ├── migrations/         # plain SQL: 00000000_000001_create_users.sql
│   ├── factories/          # user-factory.ts (tests and seeding)
│   └── seeders/            # database-seeder.ts
├── resources/
│   ├── views/              # pages: home.vue, dashboard.vue, auth/login.vue; layouts/ and errors/ too
│   ├── components/         # (yours) reusable components; any becomes an island with `hydrate`
│   ├── lang/               # en.json, fr.json, …
│   ├── styles/app.scss
│   └── client.ts           # the browser entry: mounts the islands
├── routes/                 # web.ts (pages), api.ts (JSON), schedule.ts (--full)
├── tests/feature/          # auth.test.ts
├── public/                 # static files; public/build/ holds the built assets
├── cslug.config.ts         # assets, and the processes `cslug start` runs
├── .env, .env.test         # APP_KEY, DATABASE_URL, REDIS_URL, …
└── AGENTS.md               # instructions for AI coding agents (cslug agents:sync keeps it current)
```

Imports use aliases: `#app/*`, `#config/*`, `#database/*`, `#routes/*`, `#views/*`, `#components/*`, `#resources/*`. Folder
conventions (one class per file, named in kebab-case after it) are in `docs/directory-structure.md`.

## Your first page

A table, its migration, a repository, a controller, a route and a view.

```bash
bunx cslug make:table Circuit             # app/tables/circuit-table.ts
bunx cslug make:repository Circuit        # app/repositories/circuit-repository.ts
```

```ts
// app/tables/circuit-table.ts
import { id, integer, jsonb, type Row, table, text, timestamps } from '@cslug/database'

export const circuits = table('circuits', {
  id: id(),
  slug: text().unique(),
  title: jsonb<{ fr: string; en: string }>(),
  nights: integer(),
  ...timestamps(),
})
export type Circuit = Row<typeof circuits>
```

```bash
bunx cslug make:migration --from-tables   # writes the CREATE TABLE for review (guide 09)
bunx cslug migrate
```

```ts
// app/repositories/circuit-repository.ts
import { inject } from '@cslug/core'
import { Repository } from '@cslug/database'
import { circuits } from '#app/tables/circuit-table'

@inject()
export class CircuitRepository extends Repository(circuits) {}
```

```bash
bunx cslug make:controller Circuit        # app/controllers/circuit-controller.ts
```

```ts
// app/controllers/circuit-controller.ts
import { inject } from '@cslug/core'
import type { HttpContext } from '@cslug/http'
import { view } from '@cslug/vue'
import ShowCircuit from '#views/circuits/show.vue'
import { CircuitRepository } from '#app/repositories/circuit-repository'

@inject(CircuitRepository)
export class CircuitController {
  constructor(private circuits: CircuitRepository) {}

  async show({ params }: HttpContext) {
    const circuit = await this.circuits.findByOrFail({ slug: params.slug })   // 404 when there is none
    return view(ShowCircuit, { circuit })
  }
}
```

```ts
// routes/web.ts
import { defineRoutes } from '@cslug/http'
import { CircuitController } from '#app/controllers/circuit-controller'

export default defineRoutes((r) => {
  r.get('/circuits/:slug', [CircuitController, 'show']).name('circuits.show')
})
```

```vue
<!-- resources/views/circuits/show.vue -->
<script setup lang="ts">
import { useT } from '@cslug/vue'
import Layout from '#views/layouts/default.vue'
import type { Circuit } from '#app/tables/circuit-table'

defineProps<{ circuit: Circuit }>()
const { t, tr } = useT()
</script>

<template>
  <Layout :title="tr(circuit.title)">
    <h1>{{ tr(circuit.title) }}</h1>
    <p>{{ t('circuits.nights', { count: circuit.nights }) }}</p>
  </Layout>
</template>
```

`tr()` picks the visitor's language from a translated value; `t()` reads `resources/lang/<locale>.json`
(guide 16). Visit `http://localhost:3000/circuits/tana-isalo` after inserting a row (`cslug repl`, or a seeder:
guide 09). The page is server-rendered HTML with its CSS, and no JavaScript.

## Your first island

Any component becomes an island when you add `hydrate` where you use it.

```vue
<!-- resources/components/day-map.vue -->
<script setup lang="ts">
import { ref } from 'vue'
const props = defineProps<{ stops: { name: string; lat: number; lng: number }[] }>()
const active = ref(0)
</script>

<template>
  <div class="day-map">
    <button v-for="(stop, i) in props.stops" :key="stop.name" :class="{ active: i === active }" @click="active = i">
      {{ stop.name }}
    </button>
  </div>
</template>

<style scoped lang="scss">
.day-map { display: flex; gap: .5rem; }
.active { font-weight: 600; }
</style>
```

Use it in the view:

```vue
<script setup lang="ts">
import DayMap from '#components/day-map.vue'
</script>

<DayMap :stops="stops" hydrate="visible" />   <!-- without `hydrate` it renders as static HTML -->
```

Now the page loads one small chunk, and only once the map scrolls into view. Under `cslug dev`, editing the
component updates it in the browser without losing its state (guide 08).

## Your first test

```ts
// tests/feature/circuit.test.ts
import { test } from 'bun:test'
import { testApp } from '@cslug/testing'
import { CircuitRepository } from '#app/repositories/circuit-repository'

const app = testApp()   // the app, on the test database (.env.test), each test in a rolled-back transaction

test('a circuit page', async () => {
  await app.resolve(CircuitRepository).create({ slug: 'tana-isalo', title: { fr: 'Tana – Isalo', en: 'Tana to Isalo' }, nights: 9 })
  await app.get('/circuits/tana-isalo').assertOk().assertSee('Tana to Isalo')
  await app.get('/circuits/nope').assertNotFound()
})
```

```bash
bun test
```

Guide 19 covers the test kit: HTTP and HTML assertions, factories, fakes for mail, queue and time.

## Every day

```bash
bunx cslug dev               # develop
bunx cslug routes            # what URLs exist
bunx cslug describe          # the app as data: routes, tables, config, jobs… (also for AI agents)
bunx cslug repl              # a REPL with the app booted: await resolve(CircuitRepository).all()
bun run typecheck            # TypeScript, Vue templates and view props included
bun test
```

## Where to go next

- [00 — A tour](./00-tour.md) to see a whole feature through every layer.
- [02 — Container](./02-container-and-di.md) for `@inject(...)`.
- [05 — Routing](./05-routing-and-middleware.md) and [06 — Controllers](./06-controllers.md).
- [08 — Views](./08-views-vue-scss.md) for layouts, forms, islands and styles.
- [09 — Database](./09-database.md) for tables and queries.
- [21 — Deployment](./21-deployment.md) when it goes live.
