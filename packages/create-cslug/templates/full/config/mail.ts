import { defineConfig } from '@cslug/core'
import { env } from './env'

export default defineConfig({
  from: { address: 'hello@example.com', name: '{{title}}' },
  transport: env.MAIL_TRANSPORT,
  transports: {
    smtp: { host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER, password: env.SMTP_PASSWORD },
    log: {},
  },
  queue: 'mail',
})
