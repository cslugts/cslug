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
