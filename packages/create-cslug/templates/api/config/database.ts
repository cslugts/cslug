import { defineConfig } from '@cslug/core'
import { env } from './env'

export default defineConfig({
  url: env.DATABASE_URL,
  pool: { max: 10, idleTimeout: '30s', connectTimeout: '5s' },
  slowQueryMs: 200,
})
