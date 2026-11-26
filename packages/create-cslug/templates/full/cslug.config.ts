import { defineCslugConfig } from '@cslug/cli'

/** Framework-level settings: assets and the processes `cslug start` runs. App settings live in config/. */
export default defineCslugConfig({
  assets: {
    entries: { client: 'resources/client.ts' },
    scss: true,
    tailwind: {{tailwind}},
  },
  processes: {
    web: { instances: 1 },
    worker: [{ queues: ['default', 'mail'], concurrency: 5 }],
    scheduler: true,
  },
})
