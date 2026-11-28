# @cslug/security

`SecurityProvider` reads `config/security.ts` and adds global middleware, in this order: the IP filter, the per-IP
limit, then the Content-Security-Policy. With `@cslug/auth` it adds account lockout; with `@cslug/database`, the
audit log (and records auth events). List it after `HttpProvider`. The rest of an app's defences (security
headers, CSRF, `throttle()`, signed URLs, password hashing) are in `@cslug/http` and `@cslug/auth`.

## Configuration

```ts
// config/security.ts
export default defineConfig({
  csp: {
    directives: { 'img-src': ["'self'", 'data:', 'https://images.example.com'], 'font-src': false },
    reportOnly: false,
    reportUri: '/csp-reports',
  }, // default: on with the default policy; false: off
  limit: '600/min', // default: off
  ipFilter: { allow: ['10.0.0.0/8'], deny: ['10.6.6.0/24'] },
  securityTxt: { contact: 'mailto:security@example.com', expires: '2027-06-30', preferredLanguages: ['en', 'fr'] },
  lockout: { attempts: 5, decay: '15m' }, // default: off
  audit: { keep: '365d', auth: true }, // default: on with @cslug/database; false: off
})
```

Behind a load balancer, set `http.trustedProxies`: the limit and the filter use `ctx.request.ip()`.

## Content Security Policy

`csp()` makes a 16-byte nonce per request, sets `ctx.nonce`, and the header on the response (error pages
included). The default policy:

```
default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self' 'nonce-…'; style-src-attr 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self';
form-action 'self'; frame-ancestors 'none'
```

plus `upgrade-insecure-requests` when `app.env` is `production`. `directives` replaces a directive's sources, and
`false` removes it; the nonce is always added to `script-src` and `style-src`. A response that sets its own
`Content-Security-Policy` keeps it.

`<Assets>` adds the nonce to its `<script>` and `<style>` tags, the component styles and the `cslug dev` client. Your
own inline tags take it from `useRequest().nonce`:

```vue
<script setup lang="ts">
const { nonce } = useRequest()
</script>
<template>
  <script :nonce="nonce" src="https://plausible.io/js/script.js" defer />
</template>
```

Only on some routes: `csp: false`, then `r.group({ middleware: [csp({ … })] }, …)`.

## IP filter and per-IP limit

`ipFilter({ allow, deny })` answers 403 `security.ip_denied` to an address in `deny`, or outside `allow` when it is
given. Entries are addresses or CIDR ranges, IPv4 or IPv6; an IPv4-mapped IPv6 address (`::ffff:10.0.0.1`) is
matched as IPv4. `ipInRange(ip, ranges)` is the check on its own.

`ipLimit('600/min', { except })` counts every request per IP in the `RateLimiter` (shared across processes with
`@cslug/redis`) and answers 429 with `Retry-After` past the limit. Paths in `except` (default `['/health/']`) are not
counted. Assets served from `public/` count, so leave room for them.

## security.txt

With `securityTxt`, `GET /.well-known/security.txt` answers `text/plain`: `Contact` (required, one or more),
`Expires` (default: a year after the process started), then `Encryption`, `Acknowledgments`,
`Preferred-Languages`, `Policy`, `Hiring` and `Canonical` (default: `app.url`'s). A missing contact or an invalid
`expires` fails at boot.

## Account lockout

With `lockout` and `@cslug/auth`: a `LoginAttempting` listener refuses a locked email with `AccountLockedError`
(423 `security.account_locked`, `params.retryAfter`); `LoginFailed` (wrong password, known or unknown email)
counts a failure; at `attempts` within `decay` the email is locked for `decay` and `AccountLocked`
`{ email, userId?, ip, until }` is emitted (listen to it to tell the owner). `LoginSucceeded` in the same request
resets the count. Counts and locks are in the `Cache`.

`Lockout` (injectable): `lockedUntil(email)`, `assertUnlocked(email)`, `failed(email, { userId, ip })`,
`succeeded(email)`, `unlock(email)`.

## Breached passwords

```ts
password: v.string().min(12).refineAsync(notBreached(), { message: 'validation.password_breached' })
```

`notBreached({ threshold = 1, timeout = '2s' })` asks `api.pwnedpasswords.com/range/<first 5 of SHA-1>` with
`Add-Padding: true` and looks for the rest of the hash in the answer. Down or slow: the password passes and
`security.breached_passwords_unavailable` is logged. `BreachedPasswords.count(password)` gives the number;
`BreachedPasswords.fake(['password123'])` in tests (returns a restore function; `{ unavailable: true }` simulates
an outage).

## Audit log

`cslug_audit_log` (migration `00000000_000700`): `id` (UUIDv7), `action`, `user_id`, `subject_type`, `subject_id`,
`ip`, `request_id`, `data` (jsonb), `created_at`.

```ts
await audit.record('booking.refunded', { subject: { type: 'booking', id: booking.id }, data: { amount } })
await audit.for({ type: 'booking', id: booking.id }) // newest first, { limit } (default 100)
await audit.byUser(user.id)
await audit.prune('90d') // default: audit.keep
```

`record()` takes the user (`userId` overrides it, `null` for none), IP and request id from the context and runs on
the ambient transaction. `data` is copied JSON-safe (bigint as string, dates as ISO) with keys containing
`password`, `secret`, `token`, `authorization`, `cookie`, `apikey`, `cardnumber` or `cvv` redacted. Auth events are
recorded under their event names; a failure to record one is logged, never thrown into the login.

`cslug audit:prune` deletes entries older than `audit.keep`. Without `@cslug/database`, `Audit` throws
`security.audit_needs_database`.
