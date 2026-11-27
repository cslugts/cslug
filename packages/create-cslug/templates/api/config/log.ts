import { defineConfig } from '@cslug/core'
import { env } from './env'

/** Logs: readable lines in development, JSON lines (one per entry) in production. */
export default defineConfig({
  level: env.LOG_LEVEL,
  format: env.LOG_FORMAT ?? (env.APP_ENV === 'production' ? 'json' : 'pretty'),
  // more destinations, each with its own level and format:
  // targets: [{ type: 'stdout' }, { type: 'file', path: 'storage/logs/app-{date}.log', keep: 14, format: 'json' }],
})
