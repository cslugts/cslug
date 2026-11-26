import type { Typed } from '@cslug/core'
import type { User } from '#app/tables/user-table'
import app from './app'
import auth from './auth'
import cache from './cache'
import database from './database'
import http from './http'
import i18n from './i18n'
import redis from './redis'
import session from './session'

export const configs = { app, http, database, redis, cache, session, auth, i18n }

declare module '@cslug/core' {
  /** Types `config('...')`. */
  interface Config extends Typed<typeof configs> {}
  /** Types `auth.user()` and policy arguments. */
  interface AuthUser extends User {}
}
