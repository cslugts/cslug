# Spike (a): Vue views on the server in Bun, components hydrated as islands

**Verdict: ✅ yes.** Bun can load `.vue` files at runtime, render pages to HTML with `vue/server-renderer`, turn
`<X hydrate="…">` into islands, and hydrate them in a real browser with no mismatches. No Vite is needed:
`Bun.build` with a small plugin produces one chunk per island.

Run it: `bun run.ts` (needs Google Chrome for the headless check). Throwaway code; the real implementation goes
in `@cslug/vue`.

## What was checked (all pass; Bun 1.3.14, Vue 3.5.46, Chrome headless)

| Check | Result |
|---|---|
| Runtime `.vue` loader (Bun plugin + `vue/compiler-sfc`, `<script setup lang="ts">`, type-based `defineProps`) | ✅ |
| `view(Page, props)` → full HTML; **no `<script>` on pages without islands** | ✅ |
| Island props rendered **serialized** on the server (bigint → string, Date → ISO), identical to what the browser gets | ✅ |
| Scoped CSS: same `data-v-…` id on server and browser | ✅ |
| `hydrate="load"`, `"idle"`, `"media:(…)"`: hydrated, and reactive afterwards (`onMounted` counter increments) | ✅ |
| `hydrate="visible"` far below the fold: **not** hydrated (lazy) | ✅ |
| Same component used twice statically and once as an island: only the island hydrates | ✅ |
| No hydration-mismatch warnings or errors in the browser console | ✅ |
| **Negative control:** a component that renders differently on server and browser *is* reported (`[Vue warn]: Hydration text content mismatch`), so the clean result above is real | ✅ |
| Slot content on an island (`<Counter hydrate>text</Counter>`) → compile error | ✅ |

## Numbers

| | |
|---|---|
| SSR render of the test page (≈2.6 KB HTML, 2 static + 5 island components) | **0.14–0.27 ms** (3,700–7,000 renders/s, one core) |
| First compile of an SFC on the server | 2–10 ms per file, so a cache is needed in dev and precompilation in `cslug build` |
| Browser build (`Bun.build`, 4 entries/chunks) | 65 ms |
| Vue runtime chunk, production build | **63.8 KB min, 25.4 KB gzip**, loaded only on pages with islands |
| Each island chunk | 0.4–0.7 KB |

## Findings that change the implementation or the docs

1. **Islands must be rewritten in the template source, not with a compiler `nodeTransform`.** Vue's SSR compiler
   resolves components on *enter*, before custom node transforms run. A transform renamed the tag in the browser
   build but not in the SSR build, which rendered the component directly. `rewriteIslands()` edits the SFC
   source with exact AST offsets (`MagicString`) before compiling, so both builds see identical input.
2. **The server must render islands with the serialized props.** Rendering with real rows (Date, bigint) and
   hydrating with JSON would mismatch whenever a component formats them. `CslugIsland` therefore renders
   `h(component, serialize(attrs))`. This confirms the `serialize()` + `Serialized<T>` design (gap G1).
3. **`defineProps<Serialized<{…}>>()` does not compile.** Vue's compile-time type resolver rejects a *whole*
   props type that is a mapped or conditional type (`Unresolvable type: TSConditionalType`). Using `Serialized`
   *per prop* works: `defineProps<{ day: Serialized<Day> }>()`. The guides must use the per-prop form; the
   tour's `deposit-breakdown` island is fixed.
4. **The island wrapper is `<cslug-island style="display:contents">`.** It is fine inside `<ul>`, `<div>` and
   so on. Inside `<table>`/`<tr>` the HTML parser would move it out ("foster parenting"), so an island there
   must wrap a whole table, not a row. Document this as a rule.
5. **`client.js` imports Vue statically**, so the 25 KB runtime loads as soon as a page has any island, even a
   `visible` one far below. That's acceptable; a later optimisation can lazy-load the runtime with the first
   island.

## Not covered (later milestones)

SCSS through `sass` and Tailwind, live reload and HMR, `vue-tsc` checking `view(Page, props)`, nested islands,
async `setup` inside islands, per-page CSS extraction (the spike inlines all CSS), production render-function
precompilation.
