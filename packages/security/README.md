# @cslug/security

A Content-Security-Policy with a new nonce per request (`<Assets>` from `@cslug/vue` puts it on its tags), one rate
limit over every request from an IP, an IP filter with CIDR ranges (IPv4 and IPv6), `/.well-known/security.txt`
(RFC 9116), account lockout on `@cslug/auth`'s login events, `notBreached()` for passwords (HaveIBeenPwned,
k-anonymity), and an audit log on `@cslug/database` with auth events recorded. `cslug add security` installs it, lists `SecurityProvider` and writes
`config/security.ts`.

Part of [cslug](https://github.com/cslugts/cslug). Docs: [docs/README.md](docs/README.md), [docs/api.md](docs/api.md),
[guide 24](../../guides/24-security.md).
