/**
 * @cslug/auth: session and token guards (`ctx.auth`), password hashing, magic links, API tokens, policies and
 * gates, and the `auth()`, `guest()`, `ability()`, `can()` middleware.
 */
import './types'

export { Auth, SESSION_KEY } from './auth'
export type { AuthConfig, UserSource } from './config'
export { Hash } from './hash'
export { isLocalPath, MagicLinkError, MagicLinks } from './magic-links'
export { ability, auth, authenticate, can, guest } from './middleware'
export { type Abilities, type AbilityArgs, Gate, gate, Policy } from './policy'
export { AuthProvider, userSource } from './provider'
export { type AccessToken, Tokens, tokenCan } from './tokens'
