# @cslug/vue: API

| | |
|---|---|
| `view(Page, props, { status?, headers? })` | A `Responsable`: renders the page in the request |
| `renderPage(Page, props, { http?, static? })` | `{ html, state }` (`state.islands`, `state.modules`) |
| `renderStandalone(Page, props)` | One self-contained HTML file: no scripts, CSS and `public/` images inlined, islands as plain HTML |
| `<Assets entry="client" />` | In the layout `<head>` |
| `hydrate="load \| idle \| visible \| media:(…) \| none"` | On any component use; `idle` waits at most 2 s; `:ssr="false"` + `<template #fallback>` to skip server rendering |
| `serialize(value)` / `Serialized<T>` | What an island receives (bigint → string, Date → ISO); type island props per prop: `defineProps<{ day: Serialized<Day> }>()` |
| `useRequest()` | `locale`, `user`, `csrfToken`, `errors` (first message per field), `old`, `flash`, `url`, `alternates` |
| `useT()` | `t`, `tr`, `locale`, `formatMoney`, `formatDate` in the current locale |
| `route(name, params?, options?)` | |
| `formatDuration(minutes)`, `formatMoney`, `formatDate` | |
| `useForm(initial)` | `data`, `errors`, `error`, `processing`, `response`, `post/put/patch/delete(url)` → boolean, `reset`, `clearErrors`; JSON with `X-CSRF-Token` |
| `csrfHeaders()` | For hand-written `fetch` |
| `defineStore(name, init, { persist? })` | State shared by the page's islands (fresh per call on the server) |
| `mountIslands({ setup? })` | Browser: hydrate the page's islands (`resources/client.ts`) |
| `buildAssets({ root, entries?, dev?, tailwind? })` | Also at `@cslug/vue/build` with `findIslands` and `aliasPlugin` |
| `cslug build [--dev]`, `cslug typecheck` | Commands (vue-tsc must be installed for `typecheck`) |
| `config('vue.routes')` | Name prefixes of the routes sent to the browser (default: all named routes) |
| `VueProvider` | Registers the `.vue` loader and the commands; dev mode under `cslug dev` |
| `registerVueLoader(root)` | What the provider and `@cslug/vue/register` call |
| `compileSfc(file, { root, ssr })`, `rewriteIslands(source, file)` | Used by the loader and the build |

Errors: slot content on an island (other than `#fallback`), an unknown `hydrate` value, a bound `:hydrate`,
`<style lang>` other than css/scss, and SCSS without the `sass` package are compile errors naming the file.
Props that would not survive JSON (functions, class instances, cycles) are logged in development.
