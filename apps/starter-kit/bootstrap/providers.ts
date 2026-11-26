import { DatabaseProvider } from '@cslug/database'
import { RedisProvider } from '@cslug/redis'
import { QueueProvider, ScheduleProvider } from '@cslug/queue'
import { MailProvider } from '@cslug/mail'
import { AuthProvider } from '@cslug/auth'
import { HttpProvider } from '@cslug/http'
import { VueProvider } from '@cslug/vue'
import { AppServiceProvider } from '#app/providers/app-service-provider'

/** One provider per installed @cslug/* package. Core (config, events, logger, i18n) needs none. */
export const providers = [
  DatabaseProvider,
  RedisProvider,         // binds Redis drivers for Cache, Lock, RateLimiter, SessionStore
  QueueProvider,
  ScheduleProvider,
  MailProvider,
  AuthProvider,
  HttpProvider,
  VueProvider,
  AppServiceProvider,
]
