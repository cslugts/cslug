import { readFileSync } from 'node:fs'
import { CslugError } from '@cslug/core'
import { type CompiledSfc, SfcCache } from './compiler'

/** CSS of every compiled component, by component id (collected into the page when it renders). */
export const componentStyles = new Map<string, string>()
const cache = new SfcCache()
const roots = new Map<string, { production?: boolean }>()

/** The registered app root containing `file` (the longest one), else the first registered. */
function rootOf(file: string): string {
  let best: string | undefined
  for (const root of roots.keys()) if (file.startsWith(`${root}/`) && (!best || root.length > best.length)) best = root
  return best ?? (roots.keys().next().value as string)
}

/**
 * Teach Bun to import `.vue` files (compiled for the server). `VueProvider` calls this; tests that import views
 * statically need it earlier, through bunfig.toml: `[test] preload = ["@cslug/vue/register"]`.
 * Several roots may be registered in one process (test suites with several fixture apps): each `.vue` file is
 * compiled, and its `@/…` imports resolved, against the root that contains it.
 */
export function registerVueLoader(root: string = process.cwd(), options: { production?: boolean } = {}): void {
  if (roots.has(root)) return
  roots.set(root, options)
  if (roots.size > 1) return // the plugin is already installed
  Bun.plugin({
    name: 'cslug-vue-server',
    setup(build) {
      // `@/…` → resources/… (as in the browser build)
      build.onResolve({ filter: /^@\// }, (args) => {
        const base = rootOf(args.importer)
        return { path: Bun.resolveSync(`${base}/resources/${args.path.slice(2)}`, base) }
      })
      build.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const base = rootOf(path)
        let compiled: CompiledSfc
        try {
          compiled = cache.get(path, { root: base, ssr: true, production: roots.get(base)?.production })
        } catch (error) {
          throw new CslugError('vue.compile', error instanceof Error ? error.message : String(error), { cause: error })
        }
        componentStyles.set(compiled.id, compiled.css)
        return { contents: compiled.code, loader: 'ts' }
      })
    },
  })
}

/** The first registered root. */
export const vueLoaderRoot = () => roots.keys().next().value as string | undefined

/** Every definition each `.vue` file has had in this process (development: they are all patched on a change). */
const definitions = new Map<string, Record<string, unknown>[]>()

/**
 * Development: compile a changed `.vue` file again and patch the component objects already imported, so pages
 * render the new template without restarting the process (`bun --watch` does not see files loaded by plugins).
 * Returns the component id and CSS, or undefined when this process never loaded the file. Throws on compile errors.
 */
export async function reloadComponent(path: string): Promise<{ id: string; css: string } | undefined> {
  const loaded = path in require.cache
  if (!loaded && !definitions.has(path)) return undefined
  const defs = definitions.get(path) ?? []
  if (loaded) {
    const current = (await import(path)).default as Record<string, unknown>
    if (!defs.includes(current)) defs.push(current)
    delete require.cache[path]
  }
  definitions.set(path, defs)
  const fresh = (await import(path)).default as Record<string, unknown>
  for (const def of defs) {
    for (const key of Object.keys(def)) if (!(key in fresh)) delete def[key]
    Object.assign(def, fresh)
  }
  defs.push(fresh)
  const id = fresh.__cslugId as string
  return { id, css: componentStyles.get(id) ?? '' }
}

/**
 * Development: a stylesheet changed, so recompile the CSS of the loaded components whose styles are SCSS (they may
 * `@use` it). Returns the styles that changed, by component id.
 */
export function refreshComponentStyles(paths: Iterable<string>): Record<string, string> {
  cache.clear()
  const changed: Record<string, string> = {}
  for (const path of paths) {
    if (!(path in require.cache) && !definitions.has(path)) continue
    if (!/lang=["']scss["']/.test(readFileSync(path, 'utf8'))) continue
    const base = rootOf(path)
    try {
      const { id, css } = cache.get(path, { root: base, ssr: true, production: roots.get(base)?.production })
      if (componentStyles.get(id) !== css) changed[id] = css
      componentStyles.set(id, css)
    } catch {
      // a broken component is reported when it is saved or rendered
    }
  }
  return changed
}
