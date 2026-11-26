import { defineCslugConfig } from '@cslug/cli'

/** Framework-level settings: the processes `cslug start` runs. App settings live in config/. */
export default defineCslugConfig({
  processes: {
    web: { instances: 1 },
  },
})
