/**
 * @cslug/vue: Vue views rendered on the server, components hydrated as islands (`hydrate="…"`), composables,
 * `<Assets>`, `serialize()` / `Serialized<T>`, and `renderStandalone()` for self-contained HTML files.
 */
import './types'

export { type CompiledSfc, type CompileOptions, compileSfc, componentId, rewriteIslands } from './compiler'
export { formatDate, formatDuration, formatMoney, type RequestInfo, route, useRequest, useT } from './composables'
export { registerVueLoader } from './loader'
export { VueProvider } from './provider'
export {
  type AssetManifest,
  Assets,
  CslugIsland,
  type RenderOptions,
  type RenderState,
  readManifest,
  renderPage,
  renderStandalone,
  ViewResponse,
  view,
} from './render'
export { type Serialized, serialize } from './serialize'
