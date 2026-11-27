import type { Typed } from '@cslug/core'
import type { User } from '#app/tables/user-table'
import app from './app'
import auth from './auth'
import cache from './cache'
import database from './database'
import http from './http'
import i18n from './i18n'
import log from './log'
import mail from './mail'
import queue from './queue'
import redis from './redis'
import session from './session'
import storage from './storage'

export const configs = { app, http, database, redis, cache, queue, mail, storage, session, auth, i18n, log }

declare module '@cslug/core' {
  /** Types `config('...')`. */
  interface Config extends Typed<typeof configs> {}
  /** Types `auth.user()` and policy arguments. */
  interface AuthUser extends User {}
}
