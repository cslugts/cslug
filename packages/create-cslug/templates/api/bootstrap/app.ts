import { Application } from '@cslug/core'
import { configs } from '#config/index'
import { providers } from './providers'

/** The only place an Application is built. Used by the CLI, the server, workers and tests. */
export function createApp() {
  return new Application({ root: `${import.meta.dir}/..`, configs }).useProviders(providers)
}
