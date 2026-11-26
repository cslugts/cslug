import { join } from 'node:path'
import { type Application, Clock, CslugError, Lock, ServiceProvider, token } from '@cslug/core'
import { addMigrations } from '@cslug/database'
import { API_MIDDLEWARE, type MiddlewareFn, WEB_MIDDLEWARE } from '@cslug/http'
import { type AuthConfig, isClass, type UserSource } from './config'
import { Hash } from './hash'
import { MagicLinks } from './magic-links'
import { AUTH_DEPS, authenticate } from './middleware'
import { Gate } from './policy'
import { Tokens } from './tokens'

const AUTHENTICATE = token<MiddlewareFn>('auth.authenticate')

/** The users repository of `config/auth.ts` (`users`: a class, or a function importing it lazily). */
export async function userSource(app: Application): Promise<UserSource> {
  const users = app.config<AuthConfig | undefined>('auth')?.users
  if (!users) throw new CslugError('auth.no_users', 'config/auth.ts must set `users` (your users repository)')
  const Repo = isClass(users) ? users : await (users as () => Promise<typeof users>)()
  return app.resolve(Repo as never) as UserSource
}

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
      source ??= userSource(this.app)
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
    this.app.instance(AUTH_DEPS, {
      config,
      users,
      hash: () => this.app.resolve(Hash),
      tokens: () => this.app.resolve(Tokens),
    })
  }
}
