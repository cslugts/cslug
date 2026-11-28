import { ServiceProvider } from '@cslug/core'
import { Router } from '@cslug/http'
import { assetConfig, BuildCommand, TypecheckCommand } from './commands'
import { liveRoute, startDev } from './dev'
import { registerVueLoader } from './loader'

/**
 * Registers the `.vue` loader (before the HTTP provider imports routes, controllers and views) and the `build`
 * and `typecheck` commands. Under `cslug dev` (CSLUG_DEV=1) it also builds the assets, rebuilds them on change,
 * and serves live reload and HMR (off with `cslug dev --no-hmr`, CSLUG_HMR=0). Never in production.
 */
export class VueProvider extends ServiceProvider {
  private stopDev?: () => void

  register() {
    this.commands([BuildCommand, TypecheckCommand])
    registerVueLoader(this.app.rootDir, { production: this.app.config('app.env') === 'production' })
  }

  async boot() {
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
