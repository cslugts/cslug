import { defineConfig } from '@cslug/core'
import { env } from './env'

export default defineConfig({
  name: '{{title}}',
  env: env.APP_ENV,
  url: env.APP_URL,
  key: env.APP_KEY,
  previousKeys: env.APP_PREVIOUS_KEYS,
  timezone: 'UTC',
})
