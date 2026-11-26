import { defineConfig } from '@cslug/core'

export default defineConfig({
  default: 'redis',
  prefix: 'starter:',
  stores: {
    redis: { driver: 'redis', connection: 'default' },
    memory: { driver: 'memory', max: 1000 },
  },
})
