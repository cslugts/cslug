import { defineConfig } from '@cslug/core'

export default defineConfig({
  store: 'redis',
  cookie: '{{db}}_session',
  lifetime: '14d',
  sameSite: 'lax',
})
