# 24. Security

Most of an app's defences are already on without this guide: security headers, sessions with CSRF, `throttle()`,
signed URLs, argon2id passwords, policies, encrypted columns, webhook signatures and log redaction (guides 05, 15
and 17). `@cslug/security` (`cslug add security`) adds what a public app needs next:

| | |
|---|---|
| **Content Security Policy** | a strict policy with a fresh nonce per request; `<Assets>` puts the nonce on its tags |
| **Per-IP limit** | one rate limit over every request from an address |
| **IP filter** | allow or deny addresses and CIDR ranges (IPv4 and IPv6), globally or on a group |
| **`security.txt`** | `/.well-known/security.txt` (RFC 9116), so researchers know where to report |
| **Account lockout** | an account locks after repeated failed logins (`AccountLocked` tells you, to tell its owner) |
| **Breached passwords** | `notBreached()` refuses passwords found in public breaches |
| **Audit log** | who did what, when, from where: logins and 2FA changes recorded automatically |

## Configuration

```ts
// config/security.ts
export default defineConfig({
  csp: {
    directives: { 'img-src': ["'self'", 'data:', 'https://images.example.com'] }, // merged over the defaults
    // reportOnly: true, reportUri: '/csp-reports',
  },
  limit: '600/min', // every request from one IP (health checks excepted); false: off
  ipFilter: { deny: ['203.0.113.0/24'] }, // allow: [...] lets only those in
  securityTxt: { contact: 'mailto:security@example.com', policy: 'https://example.com/security' },
  lockout: { attempts: 5, decay: '15m' },
  audit: { keep: '365d' },
})
```

Behind a load balancer, set `http.trustedProxies` first (guide 05): otherwise every visitor has the balancer's
address, and the per-IP limit and the IP filter see one client.

## Content Security Policy

CSP tells the browser which scripts and styles the page may run. An injected `<script>` (a stored XSS) has no nonce,
so it does not run. The default policy:

```
default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self' 'nonce-…'; style-src-attr 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self';
form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests (production)
```

- The nonce is new on every request and is `ctx.nonce`. `<Assets>` adds it to its `<script>` and `<style>` tags,
  and so does the `cslug dev` client; a tag you write yourself needs it too:
  `<script :nonce="useRequest().nonce">`.
- `style-src-attr 'unsafe-inline'` keeps Vue's `:style` bindings working; inline `<style>` and `<script>` still need
  the nonce.
- `directives` replaces a directive's sources (`false` removes it). Add a CDN, an analytics host or an image domain
  there. The nonce is always added to `script-src` and `style-src`.
- Trying it on a live app: `reportOnly: true` sends `Content-Security-Policy-Report-Only`, so the browser reports what
  it would block (to `reportUri`, or the console) without blocking it.
- On a group instead of the whole app: `csp: false` in the config and `r.group({ middleware: [csp()] }, …)`.

## Per-IP limit and IP filter

`limit` counts every request per IP through the `RateLimiter` (Redis with `@cslug/redis`, so the count is shared by
all web processes) and answers 429 with `Retry-After` past it. It is a floor against floods and scrapers; keep
`throttle()` on login, sign-up and other expensive routes (guide 05).

`ipFilter` answers 403. `deny` is checked first; with `allow`, only those addresses get in. Both take addresses and
CIDR ranges, IPv4 and IPv6. On a group:

```ts
import { ipFilter } from '@cslug/security'

r.group({ prefix: '/admin', middleware: [ipFilter({ allow: ['10.0.0.0/8', '2001:db8::/32'] })] }, (r) => { … })
```

## security.txt

`GET /.well-known/security.txt`, as `text/plain`:

```
Contact: mailto:security@example.com
Expires: 2027-11-28T00:00:00.000Z
Policy: https://example.com/security
Canonical: https://example.com/.well-known/security.txt
```

`contact` is required (a `mailto:` or `https:` URL, or a list). `expires` defaults to one year after the process
started; `canonical` to `app.url`'s. Also `encryption`, `acknowledgments`, `preferredLanguages` and `hiring`.

## Account lockout

After `attempts` failed passwords for one email within `decay`, `auth.attempt()` refuses it for `decay` with 423
`security.account_locked` (`params.retryAfter` in seconds), even with the right password. It counts per email, not
per IP, so it stops a slow guess spread over many addresses; `auth.throttle` still limits each IP. An unknown email
locks the same way, so the answer tells nothing about which accounts exist. A successful login resets the count.
Failures and locks live in the `Cache` (Redis with `@cslug/redis`, so every process sees them).

Tell the owner from a listener (`userId` is there when the email is an account's):

```ts
@inject(Notifier, UserRepository)
@listener(AccountLocked, { queued: true })
export class SendAccountLockedMail {
  constructor(private notifier: Notifier, private users: UserRepository) {}

  async handle({ userId, until }: AccountLocked['payload']) {
    if (userId) await this.notifier.send(await this.users.findOrFail(userId), new AccountLockedNotice(until))
  }
}

await resolve(Lockout).unlock('ada@example.com') // support unlocks an account
```

## Breached passwords

```ts
import { notBreached } from '@cslug/security'

password: v.string().min(12).refineAsync(notBreached(), { message: 'validation.password_breached' })
```

It asks HaveIBeenPwned's range API with the first 5 characters of the password's SHA-1: the password and its full
hash never leave the server. `notBreached({ threshold: 3 })` allows a password seen fewer than 3 times. If the API
is down or slow (2 s), the password is accepted and a warning is logged. In tests, `BreachedPasswords.fake([...])`.

## Audit log

```ts
@inject(Audit)
export class RefundService {
  constructor(private audit: Audit) {}

  async refund(booking: Booking) {
    // …
    await this.audit.record('booking.refunded', {
      subject: { type: 'booking', id: booking.id },
      data: { amount: booking.deposit },
    })
  }
}
```

An entry (`cslug_audit_log`, `cslug migrate` creates it) has the action, the user, the IP and the request id from
the context, the subject's type and id, and `data` (secret-looking keys redacted, as in logs). It is written in the
current transaction, so a rolled-back change leaves no entry. With `@cslug/auth`, its events are recorded on their
own, named after the event: `auth.login_succeeded`, `auth.login_failed` (reason and email), `auth.logged_out`,
`auth.two_factor_enabled`, `auth.two_factor_disabled`, `auth.recovery_codes_regenerated`, `auth.token_created` and
`auth.token_revoked` (the token as subject), and `security.account_locked`. `audit: { auth: false }` turns that off.

`audit.for({ type: 'booking', id })` and `audit.byUser(id)` read it back, newest first. `cslug audit:prune` deletes
entries older than `audit.keep`; schedule it:

```ts
// routes/schedule.ts
s.call('audit:prune', ({ resolve }) => resolve(Audit).prune()).daily()
```

## Dependency audit

CI runs `bun audit` on every pull request; a high or critical advisory fails the build. Do the same in your app's CI.

## Testing

`testApp()` runs with this package like with the others: every response has the CSP header, and the per-IP limit
counts in the in-memory `RateLimiter`. Requests made by the test client come from `127.0.0.1`.
