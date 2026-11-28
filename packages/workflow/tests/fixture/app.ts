import { Application, Logger } from '@cslug/core'
import { DatabaseProvider } from '@cslug/database'
import { QueueProvider } from '@cslug/queue'
import { RedisProvider } from '@cslug/redis'
import { WorkflowProvider } from '../../src'

/** The workflow test app: its own database, the queue (faked in tests), app/workflows discovered. */
export function fixtureApp(databaseUrl: string) {
  const app = new Application({
    root: import.meta.dir,
    configs: {
      app: { env: 'test', key: 'k'.repeat(32) },
      database: { url: databaseUrl },
      redis: { connections: { default: { url: process.env.REDIS_URL } }, prefix: `cslug-wftest:${process.pid}:` },
    },
  })
  app.useProviders([DatabaseProvider, RedisProvider, QueueProvider, WorkflowProvider])
  app.singleton(Logger, () => Logger.null())
  return app
}
