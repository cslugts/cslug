# Configuration & env

Two layers: **env** (strings from the outside world, validated once at boot) and **config** (typed objects
the app reads).

## 1. The env schema

```ts
// config/env.ts
import { defineEnv, v } from '@cslug/core'

export const env = defineEnv({
  APP_ENV: v.enum(['development', 'test', 'staging', 'production']).default('development'),
  APP_URL: v.url(),
  APP_KEY: v.string().min(32),                       // encryption + signed URLs
  DATABASE_URL: v.url(),
  REDIS_URL: v.url().default('redis://localhost:6379'),
  MAIL_TRANSPORT: v.enum(['smtp', 'resend', 'log']).default('log'),
  RESEND_API_KEY: v.string().optional(),
  PAYMENTS_DRIVER: v.enum(['mangopay', 'fake']).default('fake'),
  MANGOPAY_CLIENT_ID: v.string().optional(),
  MANGOPAY_API_KEY: v.secret().optional(),            // secret(): redacted in logs and `cslug config:show`
  ANTHROPIC_API_KEY: v.secret().optional(),
})
```

Bun loads `.env` / `.env.<APP_ENV>` natively. At boot, cslug validates **all** variables and fails with one
message listing every problem:

```
✖ Invalid environment (.env)
  APP_KEY        must be at least 32 characters (got 12)
  DATABASE_URL   is required
  Run `cslug key:generate` to create APP_KEY.
```

## 2. Config files

```ts
// config/payments.ts
import { defineConfig } from '@cslug/core'
import { env } from './env'

export default defineConfig({
  driver: env.PAYMENTS_DRIVER,
  commissionPercent: 8,
  stages: [30, 40, 30],                               // % of the package released per milestone
  mangopay: {
    clientId: env.MANGOPAY_CLIENT_ID,
    apiKey: env.MANGOPAY_API_KEY,
    baseUrl: env.APP_ENV === 'production' ? 'https://api.mangopay.com' : 'https://api.sandbox.mangopay.com',
  },
})
```

Register them once, which also gives `config()` its types:

```ts
// config/index.ts
import app from './app'
import database from './database'
import payments from './payments'
// …
export const configs = { app, database, payments /* … */ }

declare module '@cslug/core' {
  interface Config extends Typed<typeof configs> {}
}
```

## 3. Reading config

```ts
import { config } from '@cslug/core'

config('payments.commissionPercent')   // number
config('payments.stages')              // number[]
config('payments.nope')                // ✖ type error: no such key
```

A whole section is typed too: `config('payments')` returns the object from `config/payments.ts`.

**How configs reach the app.** `bootstrap/app.ts` passes them in, which is also what makes them available to the
CLI, workers and tests:

```ts
// bootstrap/app.ts
import { Application } from '@cslug/core'
import { configs } from '#config/index'
import { providers } from './providers'

export const createApp = () => new Application({ root: `${import.meta.dir}/..`, configs }).useProviders(providers)
```

## Rules

- `process.env` appears only in `config/env.ts` (lint rule).
- Config is **read-only** after boot. Tests override with `testApp({ config: { 'payments.driver': 'fake' } })`.
- `cslug config:show payments` prints the resolved config with secrets redacted.
