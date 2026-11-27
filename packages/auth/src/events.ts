import { Event } from '@cslug/core'

/**
 * What @cslug/auth emits, for audit logs, account lockout and notifications. Listeners run in the request (or with
 * `@listener(…, { queued: true })` after the commit); a `LoginAttempting` listener that throws stops the attempt.
 */

/** Before an email and password are checked (`auth.attempt`). Throw (e.g. a 423 `AppError`) to refuse it. */
export class LoginAttempting extends Event<{ email: string; ip: string | undefined }>('auth.login_attempting') {}

/** A user is signed in (after the password, the magic link, or the two-factor code). */
export class LoginSucceeded extends Event<{ userId: string; ip: string | undefined }>('auth.login_succeeded') {}

/** A wrong password (or unknown email), a wrong two-factor code, or too many attempts. */
export class LoginFailed extends Event<{
  reason: 'credentials' | 'two_factor' | 'throttled'
  email?: string
  /** When known: the account the password or code was for. */
  userId?: string
  ip: string | undefined
}>('auth.login_failed') {}

export class LoggedOut extends Event<{ userId: string | undefined; ip: string | undefined }>('auth.logged_out') {}

/** Two-factor authentication turned on (the first code was confirmed). */
export class TwoFactorEnabled extends Event<{ userId: string }>('auth.two_factor_enabled') {}
export class TwoFactorDisabled extends Event<{ userId: string }>('auth.two_factor_disabled') {}
export class RecoveryCodesRegenerated extends Event<{ userId: string }>('auth.recovery_codes_regenerated') {}

/** An API token was created (never carries the token itself). */
export class TokenCreated extends Event<{ userId: string; tokenId: string; name: string; abilities: string[] }>(
  'auth.token_created',
) {}

/** One token (`tokenId`) or all of a user's tokens (`userId`, `all`) were revoked. */
export class TokenRevoked extends Event<{ tokenId?: string; userId?: string; all?: boolean }>('auth.token_revoked') {}
