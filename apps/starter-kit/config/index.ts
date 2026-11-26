import type { Typed } from '@cslug/core'
import type { User } from '#app/tables/user-table'
import app from './app'
import http from './http'
import database from './database'
import redis from './redis'
import cache from './cache'
import queue from './queue'
import mail from './mail'
import session from './session'
import auth from './auth'
import i18n from './i18n'

export const configs = { app, http, database, redis, cache, queue, mail, session, auth, i18n }

declare module '@cslug/core' {
  /** Types `config('...')`. */
  interface Config extends Typed<typeof configs> {}
  /** Types `auth.user()` and policy arguments. */
  interface AuthUser extends User {}
}
