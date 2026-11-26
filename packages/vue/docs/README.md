# @cslug/vue

Add `VueProvider` before `HttpProvider` in `bootstrap/providers.ts`. It registers a Bun loader that compiles
`.vue` files for the server (`vue/compiler-sfc`, cached by file time). Before compiling, `<X hydrate="…">` is
rewritten to an island wrapper in the source, so the server and browser builds see the same input (see
spikes/a-vue-islands).

At render time:

1. The page renders with `vue/server-renderer`. Each component records itself, so the CSS of the components
   that rendered (scoped, SCSS compiled) goes into the page.
2. An island renders its component with the **serialized** props (what the browser will get) inside
   `<cslug-island data-island data-hydrate data-props>`.
3. `<Assets>` was a placeholder. It now becomes the CSRF meta tag, the entry CSS, the component CSS and, only
   if the page has islands, the client script and the island chunks (from `public/build/manifest.json`).

Tests that import views statically need the loader from the first line:
`[test] preload = ["@cslug/vue/register"]` in `bunfig.toml`.

The browser side (the build, `mountIslands`, browser composables) comes in M4b.
