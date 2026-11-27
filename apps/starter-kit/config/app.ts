import { defineConfig } from '@cslug/core'
import { env } from './env'

export default defineConfig({
  name: 'Starter Kit',
  env: env.APP_ENV,
  url: env.APP_URL,
  key: env.APP_KEY,
  previousKeys: env.APP_PREVIOUS_KEYS,
  timezone: 'UTC',
})
