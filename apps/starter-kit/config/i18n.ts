import { defineConfig } from '@cslug/core'

export default defineConfig({
  locales: ['en', 'fr'],
  default: 'en',
  fallback: { fr: 'en' },
  detect: ['user', 'cookie', 'header'],
})
