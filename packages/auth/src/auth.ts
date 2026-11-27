import {
  type AuthUser,
  Clock,
  currentContext,
  ForbiddenError,
  parseDuration,
  RateLimiter,
  TooManyRequestsError,
  UnauthorizedError,
} from '@cslug/core'
import type { HttpContext } from '@cslug/http'
import { type AuthConfig, field, idOf, type UserSource } from './config'
import { LoggedOut, LoginAttempting, LoginFailed, LoginSucceeded } from './events'
import type { Hash } from './hash'
import { type Abilities, type AbilityArgs, checkPolicy, Gate, type PolicyClass } from './policy'
import { type AccessToken, type Tokens, tokenCan } from './tokens'
import type { TwoFactor } from './two-factor'

/** The session key holding the signed-in user's id. */
export const SESSION_KEY = 'auth.id'
/** The session key of a password login waiting for its second factor: `{ id, until }` (ms). */
export const PENDING_KEY = 'auth.two_factor'

export type AuthDeps = {
  config: AuthConfig
  users: () => Promise<UserSource>
  hash: () => Hash
  tokens: () => Tokens
  twoFactor: () => TwoFactor
}

/**
 * Who is making this request (`ctx.auth`). The `authenticate()` middleware (in the web and api groups) loads the
 * user from the session or a `Bearer` token before the handler runs, so `user()` is synchronous.
 */
export class Auth {
  private current: AuthUser | null = null
  /** How the user was authenticated: the session (`web`) or an API token (`token`). */
  guard: 'web' | 'token' | undefined
  /** The API token, when the request used one. */
  token: AccessToken | undefined
  loaded = false

  constructor(
    private readonly ctx: HttpContext,
    private readonly deps: AuthDeps,
  ) {}

  private get hasSession(): boolean {
    return this.ctx.session.available
  }

  /** Load the user from a Bearer token, else the session (called by `authenticate()`). */
  async load(): Promise<void> {
    this.loaded = true
    const header = this.ctx.request.header('authorization')
    if (header?.startsWith('Bearer ')) {
      const token = await this.deps.tokens().verify(header.slice(7).trim())
      const user = token ? await (await this.deps.users()).find(token.userId) : null
      if (token && user) this.set(user as AuthUser, 'token', token)
      return
    }
    if (!this.hasSession) return
    const id = this.ctx.session.get<string>(SESSION_KEY)
    if (id === undefined) return
    const user = await (await this.deps.users()).find(id)
    if (user) this.set(user as AuthUser, 'web')
    else this.ctx.session.forget(SESSION_KEY) // deleted user
  }

  private set(user: AuthUser | null, guard?: 'web' | 'token', token?: AccessToken): void {
    this.current = user
    this.guard = user ? guard : undefined
    this.token = token
    const store = currentContext()
    if (store) store.userId = user ? idOf(user) : undefined
    this.ctx.user = user
  }

  /** The signed-in user; throws `UnauthorizedError` (401) for guests. */
  user(): AuthUser {
    if (!this.loaded)
      throw new Error(
        'auth.user() before authentication: add the authenticate() middleware (routes/web.ts and routes/api.ts have it)',
      )
    if (!this.current) throw new UnauthorizedError()
    return this.current
  }

  /** The user or null. */
  userOrNull(): AuthUser | null {
    return this.current
  }

  check(): boolean {
    return this.current !== null
  }

  get id(): string | undefined {
    return this.current ? idOf(this.current) : undefined
  }

  /** Sign a user in: new session id (no fixation), new CSRF token. */
  async login(user: AuthUser): Promise<void> {
    if (!this.hasSession) throw new Error('auth.login() needs the session (web routes)')
    this.ctx.session.regenerate()
    this.ctx.session.forget('_token')
    this.ctx.session.put(SESSION_KEY, idOf(user))
    this.loaded = true
    this.set(user, 'web')
    await LoginSucceeded.emit({ userId: idOf(user), ip: this.ip })
  }

  private get ip(): string | undefined {
    return this.ctx.request?.ip()
  }

  /**
   * Sign a user in, unless they turned on two-factor authentication: then the login waits for
   * `completeTwoFactor(code)` (the session remembers who, for `twoFactor.challengeLifetime`). `'two-factor'` tells the
   * controller to ask for the code. Use it after any first factor (password, magic link).
   */
  async beginLogin(user: AuthUser): Promise<'logged-in' | 'two-factor'> {
    if (!(await this.deps.twoFactor().enabled(user))) {
      await this.login(user)
      return 'logged-in'
    }
    if (!this.hasSession) throw new Error('auth.beginLogin() needs the session (web routes)')
    const lifetime = parseDuration(this.deps.config.twoFactor?.challengeLifetime ?? '10m')
    this.ctx.session.put(PENDING_KEY, { id: idOf(user), until: this.ctx.resolve(Clock).now().getTime() + lifetime })
    return 'two-factor'
  }

  /** True while a password (or magic link) login waits for its code. */
  get twoFactorPending(): boolean {
    return this.pending() !== undefined
  }

  private pending(): string | undefined {
    if (!this.hasSession) return undefined
    const p = this.ctx.session.get<{ id: string; until: number }>(PENDING_KEY)
    if (!p) return undefined
    if (p.until < this.ctx.resolve(Clock).now().getTime()) {
      this.ctx.session.forget(PENDING_KEY)
      return undefined
    }
    return p.id
  }

  /**
   * Finish a login that `beginLogin` (or `attempt`) left waiting: a code from the authenticator app or a recovery
   * code. Throttled per user like `attempt` (429). True when the user is now signed in; false for a wrong code or
   * when no login is waiting (or it expired).
   */
  async completeTwoFactor(code: string): Promise<boolean> {
    const id = this.pending()
    if (!id) return false
    const limiter = this.ctx.resolve(RateLimiter)
    const key = `two-factor:${id}`
    const hit = await limiter.hit(key, this.deps.config.throttle ?? '5/min')
    if (!hit.allowed) {
      await LoginFailed.emit({ reason: 'throttled', userId: id, ip: this.ip })
      throw new TooManyRequestsError(hit.retryAfter)
    }
    if (!(await this.deps.twoFactor().verify(id, code))) {
      this.ctx.log.warn('auth.two_factor_failed', { userId: id })
      await LoginFailed.emit({ reason: 'two_factor', userId: id, ip: this.ip })
      return false
    }
    await limiter.reset(key)
    const user = await (await this.deps.users()).find(id)
    this.ctx.session.forget(PENDING_KEY)
    if (!user) return false
    await this.login(user as AuthUser)
    return true
  }

  /** Sign out: the session is emptied and gets a new id. */
  async logout(): Promise<void> {
    const user = this.userOrNull()
    if (this.hasSession) this.ctx.session.invalidate()
    this.set(null)
    await LoggedOut.emit({ userId: user ? idOf(user) : undefined, ip: this.ip })
  }

  /**
   * Check an email and password and sign in. Throttled per email and IP (429 when exceeded), constant-time
   * whether or not the email exists, rehashes on login when the hashing parameters changed. Null on failure. A user
   * with two-factor authentication is not signed in yet: `twoFactorPending` is then true (see `beginLogin`).
   */
  async attempt(email: string, password: string): Promise<AuthUser | null> {
    const { config } = this.deps
    const hash = this.deps.hash()
    const limiter = this.ctx.resolve(RateLimiter)
    const key = `login:${email.trim().toLowerCase()}|${this.ctx.request.ip() ?? ''}`
    await LoginAttempting.emit({ email: email.trim().toLowerCase(), ip: this.ip })
    const hit = await limiter.hit(key, config.throttle ?? '5/min')
    if (!hit.allowed) {
      await LoginFailed.emit({ reason: 'throttled', email: email.trim().toLowerCase(), ip: this.ip })
      throw new TooManyRequestsError(hit.retryAfter)
    }
    const emailField = config.fields?.email ?? 'email'
    const passwordField = config.fields?.password ?? 'passwordHash'
    const users = await this.deps.users()
    const user = await users.findBy({ [emailField]: email.trim().toLowerCase() })
    const stored = user ? (field(user, passwordField) as string | null) : null
    // verify against a real hash even when there is no user, so timing does not reveal which emails exist
    const ok = await hash.verify(password, stored ?? (await dummyHash(hash)))
    if (!user || !stored || !ok) {
      this.ctx.log.warn('auth.failed', { email })
      await LoginFailed.emit({
        reason: 'credentials',
        email: email.trim().toLowerCase(),
        ...(user ? { userId: idOf(user) } : {}),
        ip: this.ip,
      })
      return null
    }
    await limiter.reset(key)
    if (config.passwords?.rehashOnLogin !== false && hash.needsRehash(stored)) {
      await users.update?.(field(user, 'id'), { [passwordField]: await hash.make(password) })
    }
    await this.beginLogin(user as AuthUser)
    return user as AuthUser
  }

  /** May the user do this? Policies: `can(BookingPolicy, 'pay', booking)`; gates: `can('admin.access')`. Guests: false. */
  async can<P extends object, A extends Abilities<P>>(
    policy: PolicyClass<P>,
    ability: A,
    ...args: AbilityArgs<P, A>
  ): Promise<boolean>
  async can(gate: string, ...args: unknown[]): Promise<boolean>
  async can(target: PolicyClass | string, ...rest: unknown[]): Promise<boolean> {
    if (!this.current) return false
    if (typeof target === 'string') return this.ctx.resolve(Gate).allows(this.current, target, rest)
    const [ability, ...args] = rest as [string, ...unknown[]]
    return checkPolicy(this.ctx.resolve(target as PolicyClass<object>), ability, this.current, args)
  }

  async cannot<P extends object, A extends Abilities<P>>(
    policy: PolicyClass<P>,
    ability: A,
    ...args: AbilityArgs<P, A>
  ): Promise<boolean>
  async cannot(gate: string, ...args: unknown[]): Promise<boolean>
  async cannot(target: PolicyClass | string, ...rest: unknown[]): Promise<boolean> {
    return !(await (this.can as (t: unknown, ...r: unknown[]) => Promise<boolean>)(target, ...rest))
  }

  /** Like `can`, but throws: `UnauthorizedError` (401) for guests, `ForbiddenError` (403) otherwise. */
  async authorize<P extends object, A extends Abilities<P>>(
    policy: PolicyClass<P>,
    ability: A,
    ...args: AbilityArgs<P, A>
  ): Promise<void>
  async authorize(gate: string, ...args: unknown[]): Promise<void>
  async authorize(target: PolicyClass | string, ...rest: unknown[]): Promise<void> {
    if (!this.current) throw new UnauthorizedError()
    if (!(await (this.can as (t: unknown, ...r: unknown[]) => Promise<boolean>)(target, ...rest)))
      throw new ForbiddenError()
  }

  /** For API tokens: does the token allow `ability`? Session users always may (abilities scope tokens only). */
  tokenCan(ability: string): boolean {
    if (!this.current) return false
    return this.guard !== 'token' || (this.token !== undefined && tokenCan(this.token, ability))
  }
}

let dummy: Promise<string> | undefined
const dummyHash = (hash: Hash) => {
  dummy ??= hash.make(crypto.randomUUID())
  return dummy
}
