/**
 * @cslug/auth: session and token guards (`ctx.auth`), password hashing, magic links, API tokens, policies and
 * gates, TOTP two-factor authentication, and the `auth()`, `guest()`, `ability()`, `can()` middleware.
 */
import './types'

export { Auth, PENDING_KEY, SESSION_KEY } from './auth'
export type { AuthConfig, UserSource } from './config'
export {
  LoggedOut,
  LoginAttempting,
  LoginFailed,
  LoginSucceeded,
  RecoveryCodesRegenerated,
  TokenCreated,
  TokenRevoked,
  TwoFactorDisabled,
  TwoFactorEnabled,
} from './events'
export { Hash } from './hash'
export { isLocalPath, MagicLinkError, MagicLinks } from './magic-links'
export { ability, auth, authenticate, can, guest } from './middleware'
export { type Abilities, type AbilityArgs, Gate, gate, Policy } from './policy'
export { AuthProvider, userSource } from './provider'
export { type AccessToken, Tokens, tokenCan } from './tokens'
export {
  base32Decode,
  base32Encode,
  hotp,
  otpauthUri,
  type TotpOptions,
  totpCode,
  totpCounter,
  totpSecret,
  verifyTotp,
} from './totp'
export { TwoFactor, type TwoFactorConfig } from './two-factor'
