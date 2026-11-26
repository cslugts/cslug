/**
 * @cslug/vue: Vue views rendered on the server, components hydrated as islands (`hydrate="…"`), composables,
 * `<Assets>`, `serialize()` / `Serialized<T>`, and `renderStandalone()` for self-contained HTML files.
 */
/// <reference path="./env.d.ts" />
import './types'

export { buildAssets } from './build'
export { BuildCommand, TypecheckCommand } from './commands'
export { type CompiledSfc, type CompileOptions, compileSfc, componentId, rewriteIslands } from './compiler'
export { formatDate, formatDuration, formatMoney, type RequestInfo, route, useRequest, useT } from './composables'
export { registerVueLoader } from './loader'
export { mountIslands } from './mount-stub'
export { VueProvider } from './provider'
export {
  type AssetManifest,
  Assets,
  CslugIsland,
  onView,
  type RenderOptions,
  type RenderState,
  readManifest,
  renderPage,
  renderStandalone,
  ViewResponse,
  view,
} from './render'
export { type Serialized, serialize } from './serialize'
export { csrfHeaders, type Form, useForm } from './shared/form'
export { defineStore } from './shared/store'
