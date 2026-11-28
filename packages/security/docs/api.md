# @cslug/security API

| Export | |
|---|---|
| `SecurityProvider` | Adds `ipFilter`, `ipLimit` and `csp` as global middleware from `config/security.ts`, and the `security.txt` route |
| `SecurityConfig` | `{ csp?: CspOptions \| false, limit?: RateLimit \| false, ipFilter?: IpFilterOptions, securityTxt?: SecurityTxtOptions \| false }` |
| `csp(options?)` | Middleware: a nonce per request on `ctx.nonce`, and the `Content-Security-Policy` (or `-Report-Only`) header |
| `CspOptions` | `{ directives?: Record<string, string[] \| false>, reportOnly?: boolean, reportUri?: string }` |
| `cspPolicy(nonce, options?, production?)` | The policy text |
| `newNonce()` | 16 random bytes, base64 |
| `ipFilter({ allow?, deny? })` | Middleware: 403 `security.ip_denied` |
| `ipInRange(ip, ranges)` | Whether an address is in a list of addresses and CIDR ranges (IPv4, IPv6) |
| `ipLimit(limit, { except? })` | Middleware: one rate limit per IP over every request; 429 with `Retry-After` |
| `securityTxt(options, { expires, canonical? })` | The body of `security.txt` (RFC 9116) |
| `SecurityTxtOptions` | `contact` (required), `expires`, `encryption`, `acknowledgments`, `preferredLanguages`, `policy`, `hiring`, `canonical` |

Errors: `security.ip_denied` (403), `http.too_many_requests` (429), `security.txt_contact` and
`security.txt_expires` (at boot).
