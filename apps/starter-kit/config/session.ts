import { defineConfig } from '@cslug/core'

export default defineConfig({
  store: 'redis',
  cookie: 'starter_session',
  lifetime: '14d',
  sameSite: 'lax',
})
