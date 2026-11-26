import { defineConfig } from '@cslug/core'

export default defineConfig({
  locales: ['en'],
  default: 'en',
  detect: ['cookie', 'header'],
})
