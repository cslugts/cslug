import { ServiceProvider } from '@cslug/core'
import { ExceptionHandler, Router } from '@cslug/http'
import { assetConfig, BuildCommand, TypecheckCommand } from './commands'
import { liveRoute, startDev } from './dev'
import { errorPages } from './error-pages'
import { MakeComponentCommand, MakeViewCommand } from './generators'
import { registerVueLoader } from './loader'

/**
 * Registers the `.vue` loader (before the HTTP provider imports routes, controllers and views), the `build` and
 * `typecheck` commands and the generators, and error views (`resources/views/errors/<status>.vue`). Under `cslug dev` (CSLUG_DEV=1) it also builds the assets, rebuilds them on change,
 * and serves live reload and HMR (off with `cslug dev --no-hmr`, CSLUG_HMR=0). Never in production.
 */
export class VueProvider extends ServiceProvider {
  private stopDev?: () => void

  register() {
    this.commands([BuildCommand, TypecheckCommand, MakeViewCommand, MakeComponentCommand])
    registerVueLoader(this.app.rootDir, { production: this.app.config('app.env') === 'production' })
  }

  async boot() {
    // resources/views/errors/<status>.vue (or 4xx.vue, 5xx.vue) for browsers, when no error handler answered
    if (this.app.has(ExceptionHandler)) this.app.resolve(ExceptionHandler).pages(errorPages(this.app.rootDir))
    if (process.env.CSLUG_DEV !== '1' || this.app.config('app.env') === 'production') return
    this.app.resolve(Router).load(liveRoute)
    this.stopDev = await startDev(this.app, {
      root: this.app.rootDir,
      dev: true,
      hmr: process.env.CSLUG_HMR !== '0',
      ...(await assetConfig(this.app.rootDir)),
    })
  }

  shutdown() {
    this.stopDev?.()
  }
}
