import type { Typed } from '@cslug/core'
import app from './app'
import cache from './cache'
import database from './database'
import http from './http'
import i18n from './i18n'
import redis from './redis'

export const configs = { app, http, database, redis, cache, i18n }

declare module '@cslug/core' {
  /** Types `config('...')`. */
  interface Config extends Typed<typeof configs> {}
}
