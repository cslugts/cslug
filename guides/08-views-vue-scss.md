# Views: Vue on the server, islands in the browser

Everything is **Vue**. Pages, layouts, components and emails are Vue SFCs **rendered on the server** to plain
HTML. A component becomes an **island** (hydrated in the browser) when you add `hydrate` where you use it.
A page with no island ships no JavaScript.

```
controller ── view(ShowCircuit, props) ──► vue/server-renderer renders the page to HTML (not hydrated)
                                             └── <DayMap hydrate="visible" … /> → HTML + props JSON + island marker
browser ──────────────────────────────────► @cslug/vue mounts only the islands, each when its condition is met
```

## Where things live

```
resources/
  views/                          # pages and layouts: rendered on the server, never hydrated
    layouts/default.vue
    layouts/admin.vue
    circuits/show.vue
    bookings/show.vue
    auth/login.vue
  components/                     # reusable components: used statically, or as islands with `hydrate`
    day-card.vue
    trip-request-form.vue
    deposit-breakdown.vue
  mail/                           # mail templates (*.vue), see guide 14
  styles/
    app.scss
    _tokens.scss
  client.ts                       # browser entry (generated, editable)
```

## A page

```vue
<!-- resources/views/circuits/show.vue -->
<script setup lang="ts">
import { useT, route } from '@cslug/vue'
import Layout from '../layouts/default.vue'
import DayCard from '#components/day-card.vue'
import TripRequestForm from '#components/trip-request-form.vue'
import type { Circuit, CircuitDay } from '#app/tables/circuit-table'

defineProps<{ circuit: Circuit; days: CircuitDay[] }>()
const { t, tr } = useT()
</script>

<template>
  <Layout :title="tr(circuit.title)" :description="tr(circuit.summary)">
    <template #head>
      <link rel="canonical" :href="route('public.circuits.show', { slug: circuit.slug }, { absolute: true })" />
    </template>

    <article class="circuit">
      <h1>{{ tr(circuit.title) }}</h1>
      <p class="lead">{{ tr(circuit.summary) }}</p>

      <p v-if="circuit.noNightDriving" class="notice">{{ t('circuits.no_night_driving') }}</p>

      <ol v-if="days.length" class="days">
        <DayCard v-for="day in days" :key="day.id" :day="day" />          <!-- static: HTML only -->
      </ol>
      <p v-else>{{ t('circuits.no_days') }}</p>

      <TripRequestForm :circuit-id="circuit.id" :seasons="circuit.seasons" hydrate="visible" />   <!-- island -->

      <a :href="route('public.visa')">{{ t('circuits.visa_link') }}</a>
    </article>
  </Layout>
</template>
```

Rendered by a controller:

```ts
import { view } from '@cslug/vue'
import ShowCircuit from '#views/circuits/show.vue'

async show({ params }: HttpContext) {
  const circuit = await this.circuits.findByOrFail({ slug: params.slug })
  return view(ShowCircuit, { circuit, days: await this.circuits.days(circuit.id) })
  //                       ^ checked against defineProps by `cslug typecheck` (vue-tsc)
}
```

`view()` options: `view(Page, props, { status: 404, headers: { … } })`.

`VueProvider` teaches Bun to import `.vue` files before the routes (and so the controllers) load. A test that
imports a view or a controller at the top of the file needs the loader earlier, from `bunfig.toml`:

```toml
[test]
preload = ["@cslug/vue/register"]
```

### Rules for views

- Views run **only on the server**: they receive real rows (`bigint`, `Date`) and can use server-only helpers
  such as `useRequest()`. They are never sent to the browser.
- `{{ value }}` is escaped. `v-html` is allowed for trusted HTML and is lint-flagged.
- No reactivity happens on the server: `ref`, `computed` and event handlers in a view render once and do nothing.
  If something needs to react, make it a component and hydrate it.
- `async setup` is supported (`await` in `<script setup>`). Prefer loading data in the controller.

## Layouts

```vue
<!-- resources/views/layouts/default.vue -->
<script setup lang="ts">
import { Assets, useRequest } from '@cslug/vue'
import SiteHeader from '#components/site-header.vue'

defineProps<{ title: string; description?: string }>()
const { locale, user, flash, alternates } = useRequest()     // the current request: read-only, server only
</script>

<template>
  <html :lang="locale">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{{ title }} · Albastr</title>
      <meta v-if="description" name="description" :content="description" />
      <link v-for="alt in alternates" :key="alt.locale" rel="alternate" :hreflang="alt.locale" :href="alt.url" />
      <Assets entry="client" />      <!-- CSS always; JS only if the page has islands -->
      <slot name="head" />           <!-- pages add canonical links, JSON-LD, … -->
    </head>
    <body>
      <SiteHeader :user="user" />
      <p v-for="(message, type) in flash" :key="type" class="flash" :data-type="type">{{ message }}</p>
      <main><slot /></main>
    </body>
  </html>
</template>
```

`useRequest()` returns `locale`, `user`, `csrfToken`, `errors`, `old`, `flash`, `url` and `alternates`
(the current page's URL in each locale). It is available in views
and in components while they render on the server. Inside a hydrated island it throws; pass what the island
needs as props.

## Components

A component in `resources/components/` is a plain Vue SFC. Where it is used decides how it runs:

```vue
<DayCard :day="day" />                       <!-- static: server HTML, no JS -->
<DayCard :day="day" hydrate="visible" />     <!-- island: same HTML, then hydrated when visible -->
```

```vue
<!-- resources/components/day-card.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import { useT, formatDuration, type Serialized } from '@cslug/vue'
import type { CircuitDay } from '#app/tables/circuit-table'

defineProps<{ day: Serialized<CircuitDay> }>()
const { t, tr } = useT()
const open = ref(false)
</script>

<template>
  <li class="day-card">
    <button type="button" @click="open = !open">
      {{ t('circuits.day', { n: day.number }) }} — {{ tr(day.title) }}
    </button>
    <p class="day-card__drive">{{ formatDuration(day.drivingMinutes) }}</p>
    <div v-show="open">{{ tr(day.details) }}</div>
  </li>
</template>

<style scoped lang="scss">
@use '@/styles/tokens' as *;
.day-card { padding: $space-3; border-bottom: 1px solid $border; }
.day-card__drive { color: $muted; }
</style>
```

Used statically, the button does nothing and `v-show` keeps the details hidden, so the static version should
show what matters by default. Used with `hydrate`, it is interactive.

**Types for components that can be islands.** Props cross the network as JSON, so type them with
`Serialized<T>` (`bigint` → `string`, `Date` → ISO `string`). Use it **per prop**:
`defineProps<{ day: Serialized<CircuitDay> }>()`. Vue's compile-time props resolver cannot handle a whole props
type written as a mapped type (`defineProps<Serialized<{ … }>>()` fails to compile). A component used only
statically may take real rows.

### `hydrate` options

| Value | Hydrates |
|---|---|
| `load` | as soon as the page loads |
| `idle` | when the browser is idle (`requestIdleCallback`), at the latest after 2 s |
| `visible` | when it scrolls into view (`IntersectionObserver`) |
| `media:(max-width: 48rem)` | when the media query matches |
| `none` | never; useful to render a component statically and say so explicitly |

Plus `:ssr="false"`: skip server rendering and show the component's `#fallback` slot until it hydrates. Use it
for widgets that only make sense in a browser, such as a map.

### Island rules

- **Props only, no slots.** Slot content would be lost on hydration, so passing a slot to a hydrated component
  is a dev-time error.
- **Props must be JSON-serialisable.** cslug serialises `bigint` and `Date` for you and warns in development
  about functions, class instances and circular data.
- **Pass rows through `serialize()`.** A view holds real rows (`Date`, `bigint`), while an island's props are
  `Serialized<T>`. `serialize(row)` returns exactly that type, so `vue-tsc` accepts
  `<TodoItem :todo="serialize(todo)" hydrate="idle" />`. At runtime the island transform serialises anyway;
  `serialize()` only fixes the type. It works on objects, arrays and nested values.
- **Island translations** are declared with `defineOptions({ lang: ['todos', 'common'] })`. `@cslug/vue`
  augments Vue's `ComponentCustomOptions`, so `vue-tsc` accepts the option.
- **Each island is its own Vue app.** Share state through a store (below), not provide/inject.
- **Islands render inside `<cslug-island>`** (`display: contents`, so it does not affect layout). Don't put an
  island directly inside `<table>`, `<tbody>` or `<tr>`: the HTML parser moves unknown elements out of tables.
  Make the whole table the island instead.
- **Browser-side helpers come from `@cslug/vue`**: `useT`, `route`, `formatMoney`, `formatDate`, `useForm`,
  `defineStore`. They work on the server too, so the same component renders in both places.

**What the browser receives:**

```html
<cslug-island data-island="components/trip-request-form" data-hydrate="visible"
              data-props="{&quot;circuitId&quot;:&quot;0193…&quot;,&quot;seasons&quot;:[&quot;apr-nov&quot;]}">
  …server-rendered HTML…
</cslug-island>
```

The build creates one chunk per component used with `hydrate` anywhere (Vue itself is one shared chunk).
`<Assets>` preloads only the chunks on the current page, and adds `<script type="application/json"
id="cslug-data">` with what the islands need: the locale, the translation namespaces they declared, the
named routes (all of them, or those listed in `config('vue.routes')`, by name prefix) and the chunk URLs.
`@cslug/vue` resolves to a browser build in islands (the `browser` export condition): the same names
(`useT`, `route`, `useForm`, …), without the server.

```ts
// resources/client.ts
import { mountIslands } from '@cslug/vue'
import './styles/app.scss'

mountIslands({
  setup(app) { /* app-wide Vue plugins for every island */ },
})
```

## Forms

### Without JavaScript

Plain HTML forms are first-class. A validation error redirects back with **errors and old input**, and
`useRequest()` exposes both. cslug ships no form components: write the markup, or make your own `<Field>` in
`resources/components/` once a pattern repeats.

```vue
<!-- resources/views/auth/login.vue -->
<script setup lang="ts">
import { useT, useRequest, route } from '@cslug/vue'
import Layout from '../layouts/default.vue'
const { t } = useT()
const { csrfToken, errors, old } = useRequest()
</script>

<template>
  <Layout :title="t('auth.login')">
    <form :action="route('login.link')" method="post">
      <input type="hidden" name="_token" :value="csrfToken" />
      <label for="email">{{ t('auth.email') }}</label>
      <input id="email" name="email" type="email" :value="old.email" :aria-invalid="!!errors.email" required />
      <p v-if="errors.email" class="error">{{ errors.email }}</p>
      <button>{{ t('auth.send_link') }}</button>
    </form>
  </Layout>
</template>
```

For `PUT`, `PATCH` and `DELETE`, add `<input type="hidden" name="_method" value="put" />` (HTML forms only send
GET and POST). Error messages in `errors` are already translated.

### In an island

```vue
<!-- resources/components/trip-request-form.vue -->
<script setup lang="ts">
import { useForm, useT, route } from '@cslug/vue'
import type { v } from '@cslug/validation'
import type { StoreTripRequestValidator } from '#app/validators/store-trip-request-validator'

const props = defineProps<{ circuitId: string; seasons: string[] }>()
const { t } = useT()

// typed from the server validator: same field names on both sides
const form = useForm<v.input<typeof StoreTripRequestValidator>>(
  { circuitId: props.circuitId, groupSize: 2, interests: [] },
  { onSuccess: () => toast(t('trip.sent')), onError: () => focusFirstError() },
)
</script>

<template>
  <!-- a real form: before hydration (or without JS) it posts and the page reloads; after, no reload -->
  <form :action="route('public.trip-requests.store')" method="post" class="trip-form" @submit.prevent="form.submit">
    <label>{{ t('trip.group_size') }}
      <input type="number" name="groupSize" v-model.number="form.data.groupSize" min="1" max="12" />
    </label>
    <p v-if="form.errors.groupSize" class="error">{{ form.errors.groupSize }}</p>
    <p v-if="form.error" class="error">{{ form.error }}</p>
    <button :disabled="form.processing">{{ t('trip.send') }}</button>
    <span v-if="form.recentlySuccessful">{{ t('trip.sent') }}</span>
  </form>
</template>
```

`form.submit` reads the form's `action`, `method` and `_method`. The controller needs nothing special: the same
code serves the plain form and the island.

```ts
async store({ request }: HttpContext) {
  const data = await request.validate(StoreTripRequestValidator)        // 422 JSON for the island, redirect back otherwise
  const trip = await this.tripRequests.create(data)
  return redirect().route('public.trip-requests.thanks', { ref: trip.ref }).with('success', t('trip.sent'))
}
```

For a request from `useForm` (or `http`), `redirect()` answers `204` with `X-Cslug-Redirect` instead of a 3xx
(which `fetch` cannot read), and the page goes there after the callbacks: flash messages show up on that page as
usual. A controller that returns JSON instead (`return { ref: trip.ref }`) fills `form.response`, and the page stays.

### `useForm()` reference

```ts
const form = useForm<Fields, Response>(initial, callbacks?)   // initial may be {} for button-only actions

form.data                        // reactive fields (File values are sent as multipart, with upload progress)
form.errors / form.hasErrors     // { field: message } from a 422, cleared on the next submit
form.error                       // a message for failures that are not field errors (419, 403, 500, network)
form.processing / form.progress  // in flight / upload { loaded, total, percentage }
form.isDirty                     // data differs from the defaults
form.wasSuccessful / form.recentlySuccessful   // the last submit succeeded / for 2 seconds after it
form.response                    // parsed JSON of the last successful response

await form.submit(event)                         // @submit.prevent="form.submit": the <form>'s action and method
await form.submit('post', url, options?)         // or form.get/post/put/patch/delete(url, options?) → true on 2xx
form.cancel()                                    // abort (a newer submit also aborts the one in flight)
form.transform((data) => ({ ...data, remember: !!data.remember }))
form.setError('email', '…') / form.setError({ … }), form.clearErrors(...fields)
form.reset(...fields), form.defaults(field?, value?)
```

Callbacks, on `useForm(initial, callbacks)` and per call (`form.post(url, { onSuccess })`; the form's run first):
`onBefore()` (return `false` to cancel), `onStart()`, `onProgress(progress)`, `onSuccess(response, { redirect })`,
`onError(errors, { status, message })`, `onCancel()`, `onFinish()`. Per call, `followRedirects: false` leaves the
page where it is and passes `redirect` to `onSuccess`.

Requests are sent as JSON (multipart when the data holds a `File`: nested objects as `key[sub]`, lists as `key[]`;
keep lists of objects out of requests with files) with `Accept: application/json` and the **CSRF token**: `<Assets>`
renders `<meta name="csrf-token">` in the page, and `useForm()` reads it and sends `X-CSRF-Token`.

### Live validation

Check a field when the user leaves it, with the same rules as the server:

```vue
<script setup lang="ts">
import { useForm } from '@cslug/vue'
import { RegisterSchema } from '#app/validators/register-schema'   // a plain `v` schema, shared with the server

const form = useForm({ name: '', email: '', password: '' }, { schema: RegisterSchema, validate: 'both' })
</script>

<template>
  <form :action="route('register.store')" method="post" @submit.prevent="form.submit">
    <input name="email" v-model="form.data.email" @blur="form.validate('email', $event)" :aria-invalid="form.invalid('email')" />
    <p v-if="form.errors.email" class="error">{{ form.errors.email }}</p>
    <span v-if="form.valid('email')">✓</span>
    …
  </form>
</template>
```

- `form.validate(field, $event?)` marks the field touched and checks it; without a field, the touched ones. It sets or
  clears only those fields' errors, and resolves to true when they are valid.
- `schema` must be a plain `v` schema (a file that imports only `@cslug/validation`), not a `Validator` class, whose
  dependencies are server-side; the route can declare the same schema, or a `Validator` that adds server checks.
- `schema` checks in the browser, instantly, with the server's messages (the `validation` namespace when the island
  loads it, else English). `validate: 'server'` (the default without a schema) asks the route instead: a
  validate-only request that runs its middleware and `.validates(schema)` but never the controller (see
  [guide 07](./07-validation.md#live-validation)); requests are debounced (`validationTimeout`, 300 ms) and leave
  files out. `'both'` asks the server once the browser check passes (for a unique email).
- The route comes from `$event` (the input's `<form>`), `useForm(data, { action, method })`, or the last submit.
- `form.validating`, `form.touched(field?)`, `form.touch(...fields)`, `form.valid(field)`, `form.invalid(field)`.

### Requests that are not forms

```ts
import { http, route } from '@cslug/vue'

const { ok, data } = await http.get<Todo[]>(route('todos.index'), { page: 2 })   // the query string
const done = await http.post(route('todos.toggle', { todo: id }))                // { ok, status, data, errors, error, redirect }
```

`http.get/post/put/patch/delete(url, data?, options?)` use the same CSRF, JSON and error handling as `useForm`, and
never throw for HTTP errors or network failures. For a hand-written `fetch`, `csrfHeaders()` gives the CSRF header.
Islands call `web` routes (the session and CSRF are there). To call `routes/api.ts` from the app's own pages as the
signed-in user, turn on stateful API requests:

```ts
// config/http.ts
api: { stateful: true },          // or a list of origins: ['https://app.albastr.test']
```

Requests from the app's own pages (their `Origin`, else `Referer`, else `Sec-Fetch-Site: same-origin`) then get the
session and CSRF on API routes, so `useForm` and `http` work there unchanged; other clients still use API tokens.

## Shared state between islands

```ts
// resources/components/stores/currency.ts
import { defineStore } from '@cslug/vue'
export const useCurrency = defineStore('currency', () => ({ code: 'EUR' as 'EUR' | 'USD' | 'GBP' }), { persist: true })
```

It is reactive, shared by all islands on the page, and optionally persisted to `localStorage`. On the server it
returns the initial value.

## Styles

**SCSS by default.** `resources/styles/app.scss` holds the global styles and is always linked, even on pages
without islands. Components use `<style scoped lang="scss">`. Scoped styles of components rendered on the page
are collected into the page CSS, **whether or not they hydrate**.

```scss
// resources/styles/_tokens.scss
$brand: #0f766e;
$danger: #b91c1c;
$muted: #6b7280;
$border: #e5e7eb;
$space-3: 0.75rem;
$radius: 0.5rem;
$content-narrow: 40rem;
```

`@` resolves to `resources/` in SCSS and imports.

### Tailwind (optional)

`bun create cslug --tailwind` (or `cslug add tailwind`) adds `resources/styles/tailwind.css`:

```css
@import "tailwindcss";
@theme { --color-brand: #0f766e; }
```

Tailwind scans `resources/**/*.vue`. It coexists with SCSS.

## The asset pipeline

No Vite. `cslug dev` and `cslug build` use `Bun.build` with cslug's plugins:

| File | Handled by |
|---|---|
| `.vue` (server) | cslug's runtime loader: `vue/compiler-sfc` with SSR output, cached, reloaded on change |
| `.vue` (browser, islands only) | cslug's `Bun.build` plugin: `vue/compiler-sfc` client output |
| `.ts` | Bun |
| `.scss` | cslug plugin using `sass` (optional peer) |
| `.css` + Tailwind | Bun CSS bundler + `bun-plugin-tailwind` (optional) |
| images, fonts | Bun, hashed |

- **`cslug dev`**: builds the assets at start, rebuilds them when `resources/` changes, and **live-reloads**
  the page over SSE; CSS changes swap the stylesheet without a reload. A server-side change restarts the
  process (`bun --watch`) and open pages reload when it is back. (Vue state-preserving HMR is not in v1.)
- **`cslug build`**: minified, hashed output in `public/build/` plus `manifest.json`. Run it before deploying
  (the Dockerfile does). Files in `public/` are served for GET requests no route matches; hashed build files
  are cached for a year. Server templates are compiled on first use (a few ms each) and cached.
- **`cslug typecheck`**: runs `vue-tsc --noEmit`. It checks `.ts` files, every `.vue` template and every
  `view(Page, props)` call. This replaces `tsc` in CI.

```ts
// cslug.config.ts
import { defineCslugConfig } from '@cslug/cli'

export default defineCslugConfig({
  assets: {
    entries: { client: 'resources/client.ts', admin: 'resources/admin.ts' },
    scss: true,
    tailwind: false,
  },
})
```

## The offline trip pack (MVP #6)

`renderStandalone()` renders a view to one self-contained HTML file, with CSS and images inlined and no
JavaScript:

```ts
import TripPack from '#views/trip-pack/show.vue'

async tripPack({ params, auth }: HttpContext) {
  const booking = await this.bookings.findOrFail(params.booking)
  await auth.authorize(BookingPolicy, 'view', booking)
  return download(await renderStandalone(TripPack, await this.tripPacks.props(booking)), `albastr-${booking.ref}.html`)
}
```
