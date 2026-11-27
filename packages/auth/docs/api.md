# @cslug/auth: API

| | |
|---|---|
| `ctx.auth` (`Auth`) | `user()`, `userOrNull()`, `check()`, `id`, `guard` (`'web' \| 'token'`), `token`, `login(user)`, `beginLogin(user)` → `'logged-in' \| 'two-factor'`, `twoFactorPending`, `completeTwoFactor(code)` → boolean, `logout()`, `attempt(email, password)` (respects 2FA), `can/cannot/authorize(Policy, ability, ...args)` or `(gate, ...args)`, `tokenCan(ability)` |
| `ctx.user` | The user or null |
| `Hash` | `make`, `verify`, `needsRehash` (argon2id via `Bun.password`; bcrypt supported) |
| `Policy` | Base class; methods `(user, ...args) => boolean`, optional `before(user)` |
| `Gate` | `define(name, (user, ...args) => boolean)` in a provider's `boot()` |
| `gate` | Static shortcut for the current app's `Gate`: `gate.define(…)`, `gate.has(name)`, `gate.allows(user, name, ...args)` |
| `userSource(app)` | The users repository of `config/auth.ts` (used by the guards and by `t.auth` in tests) |
| `Tokens` | `create(user, { name, abilities?, expiresIn? })` → `{ plainText, token }`, `verify`, `list`, `revoke`, `revokeAll` |
| `MagicLinks` | `create(user, { redirect?, lifetime? })` → `{ token, expiresAt }`; `consume(token)` → `{ user, redirectTo }` or `MagicLinkError` (400: invalid, expired, used) |
| `TwoFactor` | `enable(user, account)` → `{ secret, uri }` (`ConflictError` when already on), `confirm(user, code)` → recovery codes or null, `enabled(user)`, `verify(user, code)` (TOTP or recovery code, once), `regenerateRecoveryCodes(user)`, `remainingRecoveryCodes(user)`, `disable(user)` |
| TOTP helpers | `totpSecret()`, `totpCode(secret, at, options?)`, `verifyTotp(secret, code, at, { window, digits, period })` → time step or null, `hotp(secret, counter, digits?)`, `otpauthUri(secret, account, issuer)`, `base32Encode/Decode` |
| Middleware | `authenticate()`, `auth(guard?)`, `guest()`, `ability(...)`, `can(gate)` |
| `AuthProvider` | Config `auth`: `users`, `fields`, `passwords`, `magicLinks`, `throttle`, `loginRoute`, `home`, `twoFactor` (`issuer` = `app.name`, `window` 1, `recoveryCodes` 8, `challengeLifetime` `'10m'`) |
| `UserSource` | What `users` must provide: `find(id)`, `findBy(where)`, and optionally `update(id, values)` (stores a rehashed password on login; a database repository has it) |

Type the user once: `declare module '@cslug/core' { interface AuthUser extends User {} }`.

## Events

Emitted through core's event bus (`Event.on(…)`, `@listener(…)`), for audit logs, lockout and notifications. They
never carry passwords, codes or tokens.

| Event | Name | Payload | When |
|---|---|---|---|
| `LoginAttempting` | `auth.login_attempting` | `email`, `ip` | Before `attempt()` checks the password; a listener that throws refuses the attempt |
| `LoginSucceeded` | `auth.login_succeeded` | `userId`, `ip` | `login()` (after a password, a magic link or a two-factor code) |
| `LoginFailed` | `auth.login_failed` | `reason` (`credentials`, `two_factor`, `throttled`), `email?`, `userId?`, `ip` | A wrong password or unknown email, a wrong code, too many attempts |
| `LoggedOut` | `auth.logged_out` | `userId`, `ip` | `logout()` |
| `TwoFactorEnabled` / `TwoFactorDisabled` | `auth.two_factor_enabled` / `_disabled` | `userId` | `confirm()` / `disable()` |
| `RecoveryCodesRegenerated` | `auth.recovery_codes_regenerated` | `userId` | `regenerateRecoveryCodes()` |
| `TokenCreated` | `auth.token_created` | `userId`, `tokenId`, `name`, `abilities` | `tokens.create()` |
| `TokenRevoked` | `auth.token_revoked` | `tokenId`, or `userId` and `all` | `revoke()` / `revokeAll()` |

