# @cslug/auth

`AuthProvider` binds `Hash`, `Gate`, `Tokens`, `MagicLinks`, adds `authenticate()` to the web and api route groups
(through `@cslug/http`'s `WEB_MIDDLEWARE` / `API_MIDDLEWARE` tags), and registers the `cslug_access_tokens`
migration (`@cslug/database`'s `addMigrations`).

Per request, `authenticate()` creates `ctx.auth` and loads the user (one primary-key lookup) from a `Bearer`
token or the session's `auth.id`, so `auth.user()` is synchronous and views can read `useRequest().user`.

Security notes:
- `login()` regenerates the session id (fixation) and the CSRF token.
- `attempt()` is throttled per email + IP, verifies a dummy hash for unknown emails (no timing oracle), logs
  failures without the password, and rehashes when parameters change.
- Token secrets are stored as SHA-256 and compared in constant time.
- Magic-link redirects must be local paths.

Testing: `t.actingAs(user)` (from `@cslug/testing`) signs requests in through the session.
