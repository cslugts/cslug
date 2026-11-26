# Getting started

## Requirements

Bun ≥ 1.3, Docker (for Postgres 17, Redis 7 and Mailpit in development).

## Create an app

```bash
bun create cslug albastr             # --tailwind to add Tailwind, --api for an API-only app (no views, no Vue)
cd albastr
docker compose up -d                 # postgres, redis, mailpit
cp .env.example .env
cslug migrate
cslug dev                            # app (bun --hot) + asset watcher + queue worker + scheduler, one terminal
```

`cslug dev` prints:

```
  cslug  dev
  ➜ app       http://localhost:3000   (live reload on)
  ➜ assets    watching resources/  (3 islands, app.scss)
  ➜ worker    queues: default, notifications, payments
  ➜ schedule  4 entries (next: dispatch-daily-checkins in 3m)
  ➜ mail      http://localhost:8025   (Mailpit)
```

What got installed (the default `--web` preset): `@cslug/core`, `validation`, `http`, `vue`, `database`, `redis`,
`auth`, `cli`, and `@cslug/testing` for tests, plus `vue` and `sass` as compilers and `vue-tsc` for type-checking.
No AI, queue or mail package until you add one: `cslug add queue`, `cslug add mail`, `cslug add ai`.

## Your first page

```bash
cslug make:controller Circuit --resource=index,show     # app/controllers/circuit-controller.ts
cslug make:view circuits/show
```

```ts
// routes/web.ts
import { defineRoutes } from '@cslug/http'
import { CircuitController } from '#app/controllers/circuit-controller'

export default defineRoutes((r) => {
  r.get('/circuits/:slug', [CircuitController, 'show']).name('circuits.show')
})
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
    const circuit = await this.circuits.findByOrFail({ slug: params.slug })
    return view(ShowCircuit, { circuit, days: await this.circuits.days(circuit.id) })
  }
}
```

```vue
<!-- resources/views/circuits/show.vue -->
<script setup lang="ts">
import { useT } from '@cslug/vue'
import Layout from '../layouts/default.vue'
import type { Circuit, CircuitDay } from '#app/tables/circuit-table'

defineProps<{ circuit: Circuit; days: CircuitDay[] }>()
const { tr } = useT()
</script>

<template>
  <Layout :title="tr(circuit.title)">
    <h1>{{ tr(circuit.title) }}</h1>
    <ol>
      <li v-for="day in days" :key="day.id">
        <strong>Day {{ day.number }}</strong> — {{ tr(day.summary) }} ({{ day.drivingHours }} h driving)
      </li>
    </ol>
  </Layout>
</template>
```

Visit `http://localhost:3000/circuits/tana-isalo`. The page is server-rendered HTML with CSS and no JavaScript.

## Your first island

Any component becomes an island when you add `hydrate` where you use it.

```bash
cslug make:component day-map
```

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

<DayMap :stops="day.stops" hydrate="visible" />   <!-- without `hydrate` it would render as static HTML -->
```

Now the page loads one small chunk, and only once the map scrolls into view.

## Where to go next

- [00 — A tour](./00-tour.md) to see a whole feature.
- [02 — Container](./02-container-and-di.md) for `@inject(...)`.
- [08 — Views](./08-views-vue-scss.md) for layouts, forms, islands and styles.
- [09 — Database](./09-database.md) for tables and queries.
