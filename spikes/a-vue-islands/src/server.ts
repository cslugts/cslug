/** Server side: runtime .vue loader (Bun plugin) and view(). */
import { join } from 'node:path'
import { type Component, createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { CslugIsland } from './island'
import { compileSfc } from './sfc'

export const ROOT = join(import.meta.dir, '..')
export const styles = new Map<string, string>()
export const compileTimes: { id: string; ms: number }[] = []

Bun.plugin({
  name: 'cslug-vue-ssr',
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, ({ path }) => {
      const c = compileSfc(path, ROOT, true)
      styles.set(c.islandId, c.css)
      compileTimes.push({ id: c.islandId, ms: c.ms })
      return { contents: c.code, loader: 'ts' }
    })
  },
})

/** Render a page. JavaScript is only included when the page rendered at least one island. */
export async function view(page: Component, props: Record<string, unknown>) {
  const app = createSSRApp(page, props)
  app.component('CslugIsland', CslugIsland)
  const ctx = { islands: new Set<string>() }
  const body = await renderToString(app, ctx)
  const css = [...styles.values()].filter(Boolean).join('\n')
  const js = ctx.islands.size ? '<script type="module" src="/build/client.js"></script>' : ''
  return {
    islands: [...ctx.islands],
    html: `<!doctype html><html><head><meta charset="utf-8"><title>spike a</title><style>cslug-island{display:contents}\n${css}</style></head><body>${body}${js}</body></html>`,
  }
}
