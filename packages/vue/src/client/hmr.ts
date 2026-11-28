/**
 * Development only (`cslug dev` builds; dropped from production bundles): expose the page's Vue and @cslug/vue to
 * the hot modules the dev server builds, so an updated component shares the running instances instead of loading
 * a second copy.
 */
import * as vue from 'vue'
import * as cslug from './index'

;(globalThis as unknown as { __cslug_hmr?: Record<string, unknown> }).__cslug_hmr = { vue, '@cslug/vue': cslug }
