# @cslug/security

`SecurityProvider` reads `config/security.ts` and adds global middleware, in this order: the IP filter, the per-IP
limit, then the Content-Security-Policy. List it after `HttpProvider`. The rest of an app's defences (security
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
