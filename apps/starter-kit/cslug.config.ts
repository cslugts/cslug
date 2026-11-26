import { defineCslugConfig } from '@cslug/core'

/** Framework-level settings: paths, assets, processes. App settings live in config/. */
export default defineCslugConfig({
  assets: {
    entries: { client: 'resources/client.ts' },
    scss: true,
    tailwind: false,
  },
  processes: {
    web: { instances: 1 },
    worker: [{ queues: ['default', 'mail'], concurrency: 5 }],
    scheduler: true,
  },
})
