# @cslug/vue

Add `VueProvider` before `HttpProvider` in `bootstrap/providers.ts`.

**On the server**, it registers a Bun loader that compiles `.vue` files (`vue/compiler-sfc`, cached by file
time). Before compiling, `<X hydrate="…">` is rewritten to an island wrapper in the source, so the server and
browser builds see the same input (see spikes/a-vue-islands). At render time:

1. The page renders with `vue/server-renderer`. Each component records itself, so the CSS of the components
   that rendered (scoped, SCSS compiled) goes into the page.
2. An island renders its component with the **serialized** props (what the browser will get) inside
   `<cslug-island data-island data-hydrate data-props>`, and records its `lang` namespaces.
3. `<Assets>` was a placeholder. It becomes the CSRF meta tag, the entry CSS, the component CSS and, only if
   the page has islands, the page data (`#cslug-data`), the island chunk preloads and the client script.

**In the browser**, `@cslug/vue` resolves to `src/client` (the `browser` export condition). `mountIslands()`
imports each island's chunk when its `hydrate` condition is met and mounts it. `useT` formats ICU messages
with `@cslug/validation`'s formatter, the same one the server uses.

**The build** (`cslug build`, or `@cslug/vue/build`) runs `Bun.build` with the client entries plus one entry
per island component, writing hashed files and `manifest.json` to `public/build/`. Under `cslug dev`, the web
process builds at start, rebuilds on change and serves `/__cslug/live` (SSE) to an inline dev client
(`live-client.ts`). A changed `.vue` file is recompiled in the server process (`reloadComponent()` patches the
imported component objects: `bun --watch` does not see plugin-loaded files) and, with HMR on, built alone into
`public/build/hmr/` with `vue`, `@cslug/vue` and already-loaded components taken from the page; the browser hands
it to Vue's `__VUE_HMR_RUNTIME__` (`rerender` for template-only changes, `reload` otherwise). Development browser
builds keep the render function separate from `setup` and set `__hmrId`; production builds do not, and drop
`client/hmr.ts`. `cslug dev --no-hmr` (CSLUG_HMR=0) keeps live reload only.

Tests that import views statically need the loader from the first line:
`[test] preload = ["@cslug/vue/register"]` in `bunfig.toml`. Several app roots can register the loader in one process (a test
suite with several fixture apps): each `.vue` file compiles against the registered root that contains it.
