import { CslugError } from '@cslug/core'
import { type CompiledSfc, SfcCache } from './compiler'

/** CSS of every compiled component, by component id (collected into the page when it renders). */
export const componentStyles = new Map<string, string>()
const cache = new SfcCache()
let registered: string | undefined

/**
 * Teach Bun to import `.vue` files (compiled for the server). `VueProvider` calls this; tests that import views
 * statically need it earlier, through bunfig.toml: `[test] preload = ["@cslug/vue/register"]`.
 */
export function registerVueLoader(root: string = process.cwd(), options: { production?: boolean } = {}): void {
  if (registered) {
    if (registered !== root)
      throw new CslugError('vue.loader_root', `The .vue loader is already registered for ${registered}`)
    return
  }
  registered = root
  Bun.plugin({
    name: 'cslug-vue-server',
    setup(build) {
      // `@/…` → resources/… (as in the browser build)
      build.onResolve({ filter: /^@\// }, (args) => ({
        path: Bun.resolveSync(`${root}/resources/${args.path.slice(2)}`, root),
      }))
      build.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        let compiled: CompiledSfc
        try {
          compiled = cache.get(path, { root, ssr: true, production: options.production })
        } catch (error) {
          throw new CslugError('vue.compile', error instanceof Error ? error.message : String(error), { cause: error })
        }
        componentStyles.set(compiled.id, compiled.css)
        return { contents: compiled.code, loader: 'ts' }
      })
    },
  })
}

export const vueLoaderRoot = () => registered
