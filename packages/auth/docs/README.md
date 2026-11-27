# @cslug/auth

`AuthProvider` binds `Hash`, `Gate`, `Tokens`, `MagicLinks`, `TwoFactor`, adds `authenticate()` to the web and api
route groups (through `@cslug/http`'s `WEB_MIDDLEWARE` / `API_MIDDLEWARE` tags), and registers the
`cslug_access_tokens` and `cslug_two_factor` migrations (`@cslug/database`'s `addMigrations`).

Per request, `authenticate()` creates `ctx.auth` and loads the user (one primary-key lookup) from a `Bearer`
token or the session's `auth.id`, so `auth.user()` is synchronous and views can read `useRequest().user`.

Security notes:
- `login()` regenerates the session id (fixation) and the CSRF token.
- `attempt()` is throttled per email + IP, verifies a dummy hash for unknown emails (no timing oracle), logs
  failures without the password, and rehashes when parameters change.
- Token secrets are stored as SHA-256 and compared in constant time.
- Magic-link redirects must be local paths.
- Two-factor (TOTP, RFC 6238, checked against the RFC's test vectors): secrets encrypted with `APP_KEY`, recovery
  codes stored as SHA-256 hashes and used up atomically, each time step accepted once (atomic `last_counter` update,
  so a code cannot be replayed even across processes), codes compared in constant time, failed codes throttled.
  `attempt()` and `beginLogin()` leave a 2FA user signed out until `completeTwoFactor(code)`; `login(user)` is the
  explicit, unconditional sign-in (use it only after a second factor or for users without one).

Testing: `t.actingAs(user)` (from `@cslug/testing`) signs requests in through the session.
