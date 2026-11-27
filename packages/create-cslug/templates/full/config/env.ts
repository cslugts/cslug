import { defineEnv, v } from '@cslug/core'

export const env = defineEnv({
  APP_ENV: v.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: v.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_FORMAT: v.enum(['json', 'pretty']).optional(),
  APP_URL: v.url(),
  APP_KEY: v.secret().min(32),
  DATABASE_URL: v.url(),
  REDIS_URL: v.url().default('redis://localhost:6379'),
  MAIL_TRANSPORT: v.enum(['smtp', 'log']).default('log'),
  SMTP_HOST: v.string().default('localhost'),
  SMTP_PORT: v.coerce.int().default(1025),
  SMTP_USER: v.string().optional(),
  SMTP_PASSWORD: v.secret().optional(),
})
