import { ServiceProvider } from '@cslug/core'
import { registerVueLoader } from './loader'

/** Registers the `.vue` loader (before the HTTP provider imports routes, controllers and views). */
export class VueProvider extends ServiceProvider {
  register() {
    registerVueLoader(this.app.rootDir, { production: this.app.config('app.env') === 'production' })
  }
}
