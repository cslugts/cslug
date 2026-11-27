import { AppError, type AuthUser, type Clock, Encrypter, type Lock, parseDuration } from '@cslug/core'
import { idOf, type UserSource } from './config'

export class MagicLinkError extends AppError {
  constructor(reason: 'invalid' | 'expired' | 'used') {
    super(
      `auth.magic_link_${reason}`,
      reason === 'expired'
        ? 'This sign-in link has expired. Ask for a new one.'
        : reason === 'used'
          ? 'This sign-in link was already used. Ask for a new one.'
          : 'This sign-in link is not valid.',
      { status: 400 },
    )
  }
}

type Payload = { u: string; r?: string; e: number; n: string }
const b64 = (s: string) => Buffer.from(s).toString('base64url')

/**
 * Passwordless sign-in links. The token is signed with APP_KEY and carries the user, the redirect and the
 * expiry; "single use" is an atomic `Lock` on its nonce (Redis with @cslug/redis), so no table is needed.
 */
export class MagicLinks {
  private readonly keys: Encrypter

  constructor(
    /** The app's `Encrypter` (links signed with `APP_KEY`, accepted with a previous key too), or a key. */
    key: string | Encrypter,
    private readonly users: () => Promise<UserSource>,
    private readonly lock: Lock,
    private readonly clock: Clock,
    private readonly options: { lifetime?: string | number; singleUse?: boolean } = {},
  ) {
    this.keys = typeof key === 'string' ? new Encrypter(key) : key
    if (!this.keys.configured) throw new Error('Magic links need APP_KEY (config app.key)')
  }

  private sign = (data: string) => this.keys.sign(`magic:${data}`)

  /** A token for the user. `redirect` must be a path on this site (`/bookings`). Put it in a URL with `route()`. */
  create(
    user: AuthUser,
    options: { redirect?: string; lifetime?: string | number } = {},
  ): { token: string; expiresAt: Date } {
    if (options.redirect !== undefined && !isLocalPath(options.redirect))
      throw new Error(`Magic link redirect must be a local path, got "${options.redirect}"`)
    const expires = this.clock.now().getTime() + parseDuration(options.lifetime ?? this.options.lifetime ?? '30m')
    const payload: Payload = {
      u: idOf(user),
      e: expires,
      n: crypto.randomUUID(),
      ...(options.redirect ? { r: options.redirect } : {}),
    }
    const data = b64(JSON.stringify(payload))
    return { token: `${data}.${this.sign(data)}`, expiresAt: new Date(expires) }
  }

  /** The user and where to send them; throws `MagicLinkError` if the token is invalid, expired or used. */
  async consume(token: string): Promise<{ user: AuthUser; redirectTo: string }> {
    const [data, signature] = String(token).split('.')
    if (!data || !signature) throw new MagicLinkError('invalid')
    if (!this.keys.verify(`magic:${data}`, signature)) throw new MagicLinkError('invalid')
    let payload: Payload
    try {
      payload = JSON.parse(Buffer.from(data, 'base64url').toString())
    } catch {
      throw new MagicLinkError('invalid')
    }
    const left = payload.e - this.clock.now().getTime()
    if (left <= 0) throw new MagicLinkError('expired')
    if (this.options.singleUse !== false && !(await this.lock.acquire(`magic-link:${payload.n}`, left)))
      throw new MagicLinkError('used')
    const user = await (await this.users()).find(payload.u)
    if (!user) throw new MagicLinkError('invalid')
    return { user: user as AuthUser, redirectTo: payload.r && isLocalPath(payload.r) ? payload.r : '/' }
  }
}

/** `/bookings?x=1` yes; `//evil.com`, `https://…`, `/\evil` no. */
export const isLocalPath = (p: string) => p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\')
