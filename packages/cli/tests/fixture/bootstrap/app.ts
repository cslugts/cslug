/** The CLI's test app: http (+ database when FIXTURE_DATABASE_URL is set), a slow route, a command. */
import { Application } from '@cslug/core'
import { DatabaseProvider } from '@cslug/database'
import { HttpProvider } from '@cslug/http'

export function createApp(overrides: { root?: string; databaseUrl?: string; env?: string } = {}) {
  const db = overrides.databaseUrl ?? process.env.FIXTURE_DATABASE_URL
  const app = new Application({
    root: overrides.root ?? `${import.meta.dir}/..`,
    configs: {
      app: { env: overrides.env ?? process.env.APP_ENV ?? 'test', key: 'k'.repeat(32), url: 'http://localhost' },
      http: { shutdownTimeout: '5s' },
      log: { level: 'warn' },
      ...(db ? { database: { url: db } } : {}),
    },
  })
  return app.useProviders(db ? [DatabaseProvider, HttpProvider] : [HttpProvider])
}
