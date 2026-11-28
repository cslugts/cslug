# @cslug/security API

| Export | |
|---|---|
| `SecurityProvider` | Adds `ipFilter`, `ipLimit` and `csp` as global middleware from `config/security.ts`, and the `security.txt` route |
| `SecurityConfig` | `{ csp?: CspOptions \| false, limit?: RateLimit \| false, ipFilter?: IpFilterOptions, securityTxt?: SecurityTxtOptions \| false, lockout?: LockoutOptions \| false, audit?: { keep?, auth? } \| false }` |
| `csp(options?)` | Middleware: a nonce per request on `ctx.nonce`, and the `Content-Security-Policy` (or `-Report-Only`) header |
| `CspOptions` | `{ directives?: Record<string, string[] \| false>, reportOnly?: boolean, reportUri?: string }` |
| `cspPolicy(nonce, options?, production?)` | The policy text |
| `newNonce()` | 16 random bytes, base64 |
| `ipFilter({ allow?, deny? })` | Middleware: 403 `security.ip_denied` |
| `ipInRange(ip, ranges)` | Whether an address is in a list of addresses and CIDR ranges (IPv4, IPv6) |
| `ipLimit(limit, { except? })` | Middleware: one rate limit per IP over every request; 429 with `Retry-After` |
| `securityTxt(options, { expires, canonical? })` | The body of `security.txt` (RFC 9116) |
| `Lockout` | `lockedUntil(email)`, `assertUnlocked(email)`, `failed(email, info?)`, `succeeded(email)`, `unlock(email)` |
| `LockoutOptions` | `{ attempts?: number (5), decay?: Duration ('15m') }` |
| `AccountLocked` | Event `security.account_locked`: `{ email, userId?, ip, until }` |
| `AccountLockedError` | 423 `security.account_locked`, `params.retryAfter` |
| `notBreached({ threshold?, timeout? })` | `(password) => Promise<boolean>` for `refineAsync`; fails open |
| `BreachedPasswords` | `count(password, { timeout? })` (undefined when unavailable), `fake(passwords, { unavailable? })` |
| `Audit` | `record(action, { subject?, data?, userId? })`, `for(subject, { limit? })`, `byUser(id, { limit? })`, `prune(olderThan?)`, `keep` |
| `AuditEntry`, `AuditSubject`, `AuditStore` | An entry; `{ type, id }`; the storage interface (`store` on `Audit`) |
| `AuditPruneCommand` | `cslug audit:prune` |
| `AUDIT_MIGRATIONS` | The migrations folder (`cslug_audit_log`) |
| `SecurityTxtOptions` | `contact` (required), `expires`, `encryption`, `acknowledgments`, `preferredLanguages`, `policy`, `hiring`, `canonical` |

Errors: `security.ip_denied` (403), `http.too_many_requests` (429), `security.account_locked` (423),
`security.audit_needs_database`, `security.txt_contact` and `security.txt_expires` (at boot).
