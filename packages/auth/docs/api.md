# @cslug/auth: API

| | |
|---|---|
| `ctx.auth` (`Auth`) | `user()`, `userOrNull()`, `check()`, `id`, `guard` (`'web' \| 'token'`), `token`, `login(user)`, `logout()`, `attempt(email, password)`, `can/cannot/authorize(Policy, ability, ...args)` or `(gate, ...args)`, `tokenCan(ability)` |
| `ctx.user` | The user or null |
| `Hash` | `make`, `verify`, `needsRehash` (argon2id via `Bun.password`; bcrypt supported) |
| `Policy` | Base class; methods `(user, ...args) => boolean`, optional `before(user)` |
| `Gate` | `define(name, (user, ...args) => boolean)` in a provider's `boot()` |
| `gate` | Static shortcut for the current app's `Gate`: `gate.define(…)`, `gate.has(name)`, `gate.allows(user, name, ...args)` |
| `userSource(app)` | The users repository of `config/auth.ts` (used by the guards and by `t.auth` in tests) |
| `Tokens` | `create(user, { name, abilities?, expiresIn? })` → `{ plainText, token }`, `verify`, `list`, `revoke`, `revokeAll` |
| `MagicLinks` | `create(user, { redirect?, lifetime? })` → `{ token, expiresAt }`; `consume(token)` → `{ user, redirectTo }` or `MagicLinkError` (400: invalid, expired, used) |
| Middleware | `authenticate()`, `auth(guard?)`, `guest()`, `ability(...)`, `can(gate)` |
| `AuthProvider` | Config `auth`: `users`, `fields`, `passwords`, `magicLinks`, `throttle`, `loginRoute`, `home` |
| `UserSource` | What `users` must provide: `find(id)`, `findBy(where)`, and optionally `update(id, values)` (stores a rehashed password on login; a database repository has it) |

Type the user once: `declare module '@cslug/core' { interface AuthUser extends User {} }`.
