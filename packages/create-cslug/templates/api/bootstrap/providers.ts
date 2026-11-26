import { DatabaseProvider } from '@cslug/database'
import { HttpProvider } from '@cslug/http'
import { RedisProvider } from '@cslug/redis'
import { AppServiceProvider } from '#app/providers/app-service-provider'

/** One provider per installed @cslug/* package. Core (config, events, logger, i18n) needs none. */
export const providers = [
  DatabaseProvider,
  RedisProvider, // binds Redis drivers for Cache, Lock, RateLimiter, SessionStore
  HttpProvider,
  AppServiceProvider,
]
