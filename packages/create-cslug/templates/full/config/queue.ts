import { defineConfig } from '@cslug/core'

export default defineConfig({
  connection: 'default',
  queues: {
    default: { concurrency: 5 },
    mail: { concurrency: 5 },
  },
  failed: { keep: '14d' },
  shutdownTimeout: '30s',
})
