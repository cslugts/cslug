# Auth & authorization

**Authentication** answers "who is this?" (guards). **Authorization** answers "may they do this?" (policies
and gates).

## Users and guards

```ts
// app/tables/user-table.ts
export const users = table('users', {
  id: id(),
  email: text().notNull().unique(),
  name: text().notNull(),
  passwordHash: text(),                                  // null for magic-link-only travellers
  role: text({ enum: ['traveller', 'operator', 'staff', 'admin'] }).notNull().default('traveller'),
  locale: text({ enum: ['fr', 'en', 'it'] }).notNull().default('en'),
  emailVerifiedAt: timestamp(),
  ...timestamps(),
})
```

```ts
// config/auth.ts
export default defineConfig({
  users: () => import('#app/repositories/user-repository').then((m) => m.UserRepository),
  guards: {
    web:   { driver: 'session', lifetime: '14d' },       // Redis sessions, HttpOnly + Secure + SameSite=Lax, CSRF
    token: { driver: 'token', abilities: true },         // opaque, SHA-256 hashed, expiring, scoped
  },
  passwords: { algorithm: 'argon2id', rehashOnLogin: true },
  magicLinks: { lifetime: '30m', singleUse: true },
})
```

## Logging in

**Travellers: magic link** (no password for a one-off booking).

```ts
@inject(UserRepository, MagicLinks, Mailer)
export class MagicLinkController {
  constructor(private users: UserRepository, private links: MagicLinks, private mailer: Mailer) {}

  async send({ request }: HttpContext) {
    const { email } = await request.validate(v.object({ email: v.email() }))
    const user = await this.users.findBy({ email })
    if (user) await this.mailer.to(user).send(new MagicLinkMail(await this.links.create(user, { redirect: '/bookings' })))
    return redirect().back().with('success', t('auth.link_sent'))      // same answer either way
  }

  async consume({ params, auth }: HttpContext) {
    const { user, redirectTo } = await this.links.consume(params.token)    // throws if expired or used
    await auth.login(user)
    return redirect().to(redirectTo)
  }
}
```

**Staff and operators: password** (+ optional TOTP for staff).

```ts
const user = await auth.attempt(email, password)    // throttled, constant-time, logs failures without the password
if (!user) throw new ValidationError({ email: ['auth.failed'] })
```

**API tokens** for operator integrations:

```ts
const { plainText } = await tokens.create(user, { name: 'quote-bot', abilities: ['quotes:write'], expiresIn: '90d' })
// requests: Authorization: Bearer <plainText>   routes: .middleware(auth('token'), ability('quotes:write'))
```

In handlers: `auth.user()` (throws `UnauthorizedError` if not logged in), `auth.check()`, `auth.logout()`.

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

One policy per resource, an `@inject()` class whose methods return `boolean` (or throw a typed error for a
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
await auth.authorize('operators.verify')
```
