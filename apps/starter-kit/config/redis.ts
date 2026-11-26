import { defineConfig } from '@cslug/core'
import { env } from './env'

export default defineConfig({
  connections: { default: { url: env.REDIS_URL } },
})
