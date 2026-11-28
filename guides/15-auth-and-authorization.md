# Auth & authorization

**Authentication** answers "who is this?" (guards). **Authorization** answers "may they do this?" (policies
and gates).

## Users and guards

```ts
// app/tables/user-table.ts
export const users = table('users', {
  id: id(),
  email: text().unique(),
  name: text(),
  passwordHash: text().nullable(),                       // null for magic-link-only travellers
  role: text().oneOf(['traveller', 'operator', 'staff', 'admin']).default('traveller'),
  locale: text().oneOf(['fr', 'en', 'it']).default('en'),
  emailVerifiedAt: timestamp().nullable(),
  ...timestamps(),
})
export type User = Row<typeof users>
```

```ts
// config/auth.ts
export default defineConfig({
  users: () => import('#app/repositories/user-repository').then((m) => m.UserRepository),
  passwords: { algorithm: 'argon2id', rehashOnLogin: true },   // also memoryCost, timeCost (argon2), cost (bcrypt)
  magicLinks: { lifetime: '30m', singleUse: true },
  throttle: '5/min',                                     // auth.attempt(), per email + IP
  loginRoute: 'login',                                   // where auth() sends guests (HTML requests)
  home: '/',                                             // where guest() sends signed-in users
  fields: { email: 'email', password: 'passwordHash' },  // the user row's field names (these are the defaults)
  twoFactor: { issuer: 'My app', window: 1, recoveryCodes: 8, challengeLifetime: '10m' },
})
```

Two guards: **`web`** (the session: HttpOnly, SameSite=Lax, CSRF; stored in Redis with `@cslug/redis`) and
**`token`** (API tokens: opaque, SHA-256 hashed, expiring, scoped by abilities). `authenticate()`, which
`AuthProvider` adds to the web and api route groups, loads the user from a `Bearer` token or the session
before the handler runs. `ctx.auth.guard` says which one was used.

## Logging in

**Travellers: magic link** (no password for a one-off booking).

```ts
@inject(UserRepository, MagicLinks, Mailer)
export class MagicLinkController {
  constructor(private users: UserRepository, private links: MagicLinks, private mailer: Mailer) {}

  async send({ request }: HttpContext) {
    const { email } = await request.validate(v.object({ email: v.email() }))
    const user = await this.users.findBy({ email })
    if (user) {
      const { token } = this.links.create(user, { redirect: '/bookings' })     // signed, expiring, single use
      await this.mailer.to(user).send(new MagicLinkMail(route('login.magic', { token }, { absolute: true })))
    }
    return redirect().back().with('success', t('auth.link_sent'))      // same answer either way
  }

  async consume({ params, auth }: HttpContext) {
    const { user, redirectTo } = await this.links.consume(params.token)    // throws if expired or used
    if ((await auth.beginLogin(user)) === 'two-factor') return redirect().to(route('two-factor'))
    return redirect().to(redirectTo)
  }
}
```

**Staff and operators: password**, with a second factor for those who turn it on.

```ts
const user = await auth.attempt(email, password)    // throttled, constant-time, logs failures without the password
if (!user) throw new ValidationError({ email: ['auth.failed'] })
if (auth.twoFactorPending) return redirect().to(route('two-factor'))   // not signed in until the code
return redirect().intended('/dashboard')
```

## Two-factor authentication (TOTP)

The codes of Google Authenticator, 1Password, Authy… (RFC 6238). `TwoFactor` is injectable:

```ts
@inject(TwoFactor)
export class TwoFactorController {
  constructor(private twoFactor: TwoFactor) {}

  async enable({ auth }: HttpContext) {                                 // settings page, signed in
    const { secret, uri } = await this.twoFactor.enable(auth.user(), auth.user().email)
    return view(TwoFactorSettings, { secret, uri })                     // show `uri` as a QR code, or the secret
  }

  async confirm({ request, auth }: HttpContext) {
    const { code } = await request.validate(v.object({ code: v.string() }))
    const recoveryCodes = await this.twoFactor.confirm(auth.user(), code)   // on from now on
    if (!recoveryCodes) throw new ValidationError({ code: ['auth.two_factor_failed'] })
    return view(RecoveryCodes, { recoveryCodes })                       // shown once: ask the user to keep them
  }

  async challenge({ request, auth }: HttpContext) {                     // POST /two-factor, after the password
    const { code } = await request.validate(v.object({ code: v.string() }))
    if (!(await auth.completeTwoFactor(code))) throw new ValidationError({ code: ['auth.two_factor_failed'] })
    return redirect().intended('/dashboard')
  }
}
```

- After the password (or a magic link, with `auth.beginLogin(user)`), a user with 2FA is **not signed in**: the
  session remembers who for 10 minutes (`twoFactor.challengeLifetime`), and `auth.completeTwoFactor(code)` signs
  them in with a new session id. It accepts a code from the app or one of the **recovery codes**.
- A code is accepted **once** (the last time step used is stored), within ±30 s of clock drift
  (`twoFactor.window`); a recovery code once. Failed codes are throttled like passwords (`auth.throttle`).
- The secret is stored encrypted with `APP_KEY` in `cslug_two_factor`; recovery codes as hashes.
- `twoFactor.enabled(user)`, `regenerateRecoveryCodes(user)`, `remainingRecoveryCodes(user)`, `disable(user)`.
  Requiring it for staff is a gate: `gate.define('staff.secure', (u) => …)` with `twoFactor.enabled(u)`.
- Apps made with `bun create cslug --web` (or `--full`) already have the code step: `SessionController` sends a
  waiting login to `/two-factor`, and `TwoFactorChallengeController` signs it in. Add enrolment (a settings page
  calling `enable` and `confirm`) when your users need it.
- cslug gives the `otpauth://` URI, not a QR image: render it in the browser with a QR component, or show the
  secret to type in.

**API tokens** for operator integrations:

```ts
const { plainText, token } = await tokens.create(user, { name: 'quote-bot', abilities: ['quotes:write'], expiresIn: '90d' })
// show plainText once: only its SHA-256 is stored
// requests: Authorization: Bearer <plainText>   routes: .middleware(auth('token'), ability('quotes:write'))

await tokens.list(user)              // the user's tokens (name, abilities, last used, expiry): a settings page
await tokens.revoke(token.id)        // one
await tokens.revokeAll(user)         // all of them ("sign out everywhere" for integrations)
```

In a handler, `auth.guard` is `'web'` or `'token'`, `auth.token` the token used, and `auth.tokenCan('quotes:write')`
checks an ability in code (session users pass, like `ability()`). Abilities are free-form strings; `'*'` grants all.

The app's own pages can call the same API routes with the session instead of a token: `http.api.stateful: true`
gives `routes/api.ts` the session and CSRF for requests from `app.url`'s origin (see [guide 08](./08-views-vue-scss.md#requests-that-are-not-forms)).
`auth()` then accepts either; `auth('token')` still requires a token.

In handlers: `auth.user()` (throws `UnauthorizedError` if not logged in), `auth.userOrNull()`, `auth.check()`,
`auth.login(user)` (new session id and CSRF token), `auth.logout()`. `ctx.user` is the user or null, and views
get it from `useRequest().user`.

Route middleware: `auth()` (guests: 401 for JSON, else a redirect to the login route that remembers the URL for
`redirect().intended()`), `auth('token')` (API tokens only), `guest()`, `ability('quotes:write')` (token
abilities; session users pass), `can('admin.access')` (a gate). Magic links are signed with `APP_KEY` (and still
accepted after a key rotation while the old key is in `APP_PREVIOUS_KEYS`).
"Single use" is an atomic lock on the link's nonce, so they need no table. API tokens live in
`cslug_access_tokens`, a migration that `@cslug/auth` adds to `cslug migrate`.

**Events.** Auth emits `LoginAttempting`, `LoginSucceeded`, `LoginFailed` (wrong password, wrong code, throttled),
`LoggedOut`, `TwoFactorEnabled` / `TwoFactorDisabled`, `RecoveryCodesRegenerated`, `TokenCreated` and `TokenRevoked`
(payloads in `packages/auth/docs/api.md`). Listen to record them or to warn a user; a `LoginAttempting` listener that
throws refuses the attempt:

```ts
LoginFailed.on(({ reason, userId, ip }) => log.warn('login failed', { reason, userId, ip }))
```

**Typing `auth.user()`.** The framework learns the app's user type through module augmentation, once, next to
the configs:

```ts
// config/index.ts
declare module '@cslug/core' {
  interface AuthUser extends User {}          // User = Row<typeof users>
}
```

`auth.user()`, policy methods and gate callbacks then receive a `User`. The repository that loads users is
`config/auth.ts` → `users: UserRepository`.

**Hashing passwords.** `Hash` (argon2id through `Bun.password`) is injectable:

```ts
@inject(UserRepository, Hash)
export class RegisterController {
  constructor(private users: UserRepository, private hash: Hash) {}

  async store({ request, auth }: HttpContext) {
    const { name, email, password } = await request.validate(RegisterValidator)
    const user = await this.users.create({ name, email, passwordHash: await this.hash.make(password) })
    await auth.login(user)
    return redirect().to(route('todos.index'))
  }
}
```

`hash.make(plain)`, `hash.verify(plain, hash)`, `hash.needsRehash(hash)`. `auth.attempt()` uses them and rehashes
on login when the parameters change.

## Policies

`cslug make:policy Booking` writes `app/policies/booking-policy.ts`. One policy per resource, an `@inject()` class whose methods return `boolean` (or throw a typed error for a
specific message).

```ts
// app/policies/booking-policy.ts
import { inject } from '@cslug/core'
import { Policy } from '@cslug/auth'
import type { User } from '#app/tables/user-table'
import type { Booking } from '#app/tables/booking-table'
import { OperatorRepository } from '#app/repositories/operator-repository'

@inject(OperatorRepository)
export class BookingPolicy extends Policy {
  constructor(private operators: OperatorRepository) { super() }

  /** Staff can do everything; runs before every ability. */
  before(user: User) {
    if (user.role === 'admin' || user.role === 'staff') return true
  }

  async view(user: User, booking: Booking) {
    return booking.travellerId === user.id || (await this.isOperatorOf(user, booking))
  }

  pay(user: User, booking: Booking) {
    return booking.travellerId === user.id && booking.status === 'proposed'
  }

  release(_user: User, _booking: Booking) {
    return false                                     // only staff (via before), approved by hand in the MVP
  }

  private async isOperatorOf(user: User, booking: Booking) {
    return (await this.operators.forUser(user.id))?.id === booking.operatorId
  }
}
```

Use it:

```ts
await auth.authorize(BookingPolicy, 'pay', booking)         // throws ForbiddenError
if (await auth.can(BookingPolicy, 'release', booking)) { … }
```

`ability` is typed from the policy's method names, and the arguments from that method's parameters.

In views and islands, pass permissions as props rather than duplicating the logic:

```ts
return view(ShowBooking, { booking, canCancel: await auth.can(BookingPolicy, 'cancel', booking) })
```

## Gates (abilities without a resource)

```ts
// app/providers/auth-service-provider.ts → boot()
gate.define('admin.access', (user) => user.role === 'admin' || user.role === 'staff')
gate.define('operators.verify', (user) => user.role === 'admin')
```

```ts
r.group({ prefix: '/admin', middleware: [auth(), can('admin.access')] }, …)
await auth.authorize('operators.verify')                // throws ForbiddenError
if (await auth.cannot('operators.verify')) { … }
gate.allows(user, 'admin.access')                       // for a user other than the signed-in one (a job)
```

Guests are never allowed: `can()` and `authorize()` refuse them before calling the policy or the gate.

## Testing

```ts
const app = testApp()
app.actingAs(await UserFactory.create({ role: 'admin' }))       // requests of this test are signed in
await app.get('/admin').assertOk()
expect(app.auth.check()).toBe(true)                             // who the last response left signed in
const { plainText } = await app.tokens.create(user, { abilities: ['quotes:read'] })
await app.get('/api/quotes').withToken(plainText).assertOk()
```

`totpCode(secret, new Date())` computes the current code of a secret, to test the two-factor step.
