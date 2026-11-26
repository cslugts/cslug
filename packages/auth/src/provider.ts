import { join } from 'node:path'
import { Clock, CslugError, Lock, ServiceProvider, token } from '@cslug/core'
import { addMigrations } from '@cslug/database'
import { API_MIDDLEWARE, type MiddlewareFn, WEB_MIDDLEWARE } from '@cslug/http'
import type { AuthDeps } from './auth'
import { type AuthConfig, isClass, type UserSource } from './config'
import { Hash } from './hash'
import { MagicLinks } from './magic-links'
import { AUTH_DEPS, authenticate } from './middleware'
import { Gate } from './policy'
import { Tokens } from './tokens'

const AUTHENTICATE = token<MiddlewareFn>('auth.authenticate')

/**
 * Binds `Hash`, `Gate`, `Tokens` and `MagicLinks`, adds `authenticate()` to the web and api groups, and the
 * access-tokens migration. Config: `config/auth.ts`.
 */
export class AuthProvider extends ServiceProvider {
  register() {
    const configured = this.app.config<AuthConfig | undefined>('auth')
    if (!configured?.users)
      throw new CslugError('auth.no_users', 'config/auth.ts must set `users` (your users repository)')
    const config: AuthConfig = configured
    addMigrations(join(import.meta.dir, '../migrations'))

    let source: Promise<UserSource> | undefined
    const users = () => {
      source ??= (async () => {
        const Repo = isClass(config.users) ? config.users : await (config.users as () => Promise<typeof config.users>)()
        return this.app.resolve(Repo as never) as UserSource
      })()
      return source
    }
    this.app.singleton(Hash, () => new Hash(config.passwords))
    this.app.singleton(Gate, () => new Gate())
    this.app.singleton(
      MagicLinks,
      (c) =>
        new MagicLinks(
          this.app.config<string>('app.key') ?? '',
          users,
          c.resolve(Lock),
          c.resolve(Clock),
          config.magicLinks,
        ),
    )
    this.app.instance(AUTHENTICATE, authenticate())
    this.app.tag([AUTHENTICATE], WEB_MIDDLEWARE)
    this.app.tag([AUTHENTICATE], API_MIDDLEWARE)
    const deps: AuthDeps = { config, users, hash: undefined as unknown as Hash, tokens: () => this.app.resolve(Tokens) }
    Object.defineProperty(deps, 'hash', { get: () => this.app.resolve(Hash) })
    ;(this.app as unknown as Record<symbol, AuthDeps>)[AUTH_DEPS] = deps
  }
}
