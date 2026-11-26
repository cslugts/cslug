import { defineConfig } from '@cslug/core'

export default defineConfig({
  port: 3000,
  shutdownTimeout: '10s',
  bodyLimit: '1mb',
  trustedProxies: ['loopback'],
  cors: { origins: [] },
})
