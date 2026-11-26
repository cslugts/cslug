# @cslug/vue: API

| | |
|---|---|
| `view(Page, props, { status?, headers? })` | A `Responsable`: renders the page in the request |
| `renderPage(Page, props, { http?, static? })` | `{ html, state }` (`state.islands`, `state.modules`) |
| `renderStandalone(Page, props)` | One self-contained HTML file: no scripts, CSS and `public/` images inlined, islands as plain HTML |
| `<Assets entry="client" />` | In the layout `<head>` |
| `hydrate="load \| idle \| visible \| media:(…) \| none"` | On any component use; `:ssr="false"` + `<template #fallback>` to skip server rendering |
| `serialize(value)` / `Serialized<T>` | What an island receives (bigint → string, Date → ISO); type island props per prop: `defineProps<{ day: Serialized<Day> }>()` |
| `useRequest()` | `locale`, `user`, `csrfToken`, `errors` (first message per field), `old`, `flash`, `url`, `alternates` |
| `useT()` | `t`, `tr`, `locale`, `formatMoney`, `formatDate` in the current locale |
| `route(name, params?, options?)` | |
| `formatDuration(minutes)`, `formatMoney`, `formatDate` | |
| `VueProvider` | Registers the `.vue` loader |
| `registerVueLoader(root)` | What the provider and `@cslug/vue/register` call |
| `compileSfc(file, { root, ssr })`, `rewriteIslands(source, file)` | Used by the loader and the build |

Errors: slot content on an island (other than `#fallback`), an unknown `hydrate` value, a bound `:hydrate`,
`<style lang>` other than css/scss, and SCSS without the `sass` package are compile errors naming the file.
Props that would not survive JSON (functions, class instances, cycles) are logged in development.
