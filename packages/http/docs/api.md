# @cslug/http: API

## Routes

`defineRoutes((r) => { … })`, loaded by `HttpProvider` from `routes/web.ts` (web group) and `routes/api.ts`
(api group); `router.load(fn, group)` for more.

| | |
|---|---|
| `r.get/post/put/patch/delete/options(path, action)` | `action`: `[Controller, 'method']`, a single-action class (`handle`), or a closure |
| `.name(n)`, `.middleware(...m)`, `.where('param', /re/)` | |
| `.validates(schema)` | Live validation: a request with `X-Cslug-Validate: field,…` (or `*`) runs the route's middleware and this schema, answers `204` (`X-Cslug-Validated: 1`) or `422` with only those fields' errors, and never calls the handler; without `.validates()` such a request is `400` (`http.no_live_validation`) |
| `r.group({ prefix, domain, middleware, as, ...meta }, fn)` | Nested groups accumulate prefix, middleware and name prefix; `domain` may contain `:params` |
| `r.resource('operators', Ctl).only([...]) / .except([...])` | index, create, store, show, edit, update (PATCH), destroy; nested `'operators.documents'` |

Matching: routes with a domain first; static segments beat parameters beat wildcards; trailing slash ignored;
parameters URL-decoded; `HEAD` → `GET` without a body; a known path with another method → **405** with `Allow`.

## URLs

`route(name, params?, { absolute?, query?, signed?, expiresIn? })`: unknown params become the query string; a route
on another domain is absolute; `signed` adds an HMAC (APP_KEY) checked by the `signed()` middleware;
`urlFor(router, appUrl, key, …)` and `verifySignedUrl(url, key)` for code without an app context.

## `HttpContext`

`request`, `params`, `response` (`header()`, `cookie()`, `status`), `app`, `scope`, `requestId`, `signal`, `log`,
`locale`, `routeName`, `resolve(token)`. Packages augment it (`declare module '@cslug/http' { interface HttpContext { … } }`).

`HttpRequest`: `method`, `path`, `url`, `headers`, `header()`, `ip()` (X-Forwarded-For only from
`http.trustedProxies`, `'loopback'` allowed), `query()`, `queryAll()`, `body()` (JSON; forms with `a[b]`/`a[]`
keys; files), `raw()` (bytes, for signatures), `input()`, `file()`, `wantsJson()`, `isJson`, `isForm`,
`validate(schema | Validator | ValidatorClass | StandardSchema, { from? })`. Query and form input is coerced to the
schema: numbers, checkboxes, single → array, `''` → undefined for optional fields. Validator classes are built by
the container (DI).

## Responses

Return a `Response`, a `Responsable` (`toResponse(ctx)`), an object/array (JSON: bigint → string, Date → ISO,
`toJSON()`), a string (`text/plain`), or `null`/`undefined` (204). Helpers: `json`, `created`, `accepted`,
`noContent`, `download(content, filename, type?)`, `stream(asyncIterable)`, `sse(asyncIterable)`,
`redirect().route(name, params) / .to(url) / .away(url) / .back(fallback) / .intended(fallback) / .with(key, value)`.
For a request with `X-Cslug-Request: 1` (from `@cslug/vue`'s `useForm` / `http`), it answers `204` with
`X-Cslug-Redirect: <url>` instead of a 3xx (flashes are kept), so `fetch` can read where to go.
(303 after non-GET; `.with()` and `.intended()` need the session).

## Errors (`ExceptionHandler`)

`ValidationError` → 422 with translated `errors`; `AppError` subclasses → their status, `code`, `params`; anything
else → 500, logged with the stack, **no detail in production** (detail + short stack otherwise). API clients get
`application/problem+json` (`type`, `title`, `status`, `code`, `requestId`, …); browsers a minimal HTML page.
Extend with `handler.render(fn)` (first match wins) and `handler.report(fn)` (5xx).

## Middleware (`@cslug/http/middleware`)

`securityHeaders({ hsts?, csp?, frameOptions? })` (global by default), `bodyLimit(size)` (global `1mb`; also
enforced on bytes read), `timeout(duration)` (503, aborts `ctx.signal`), `signed()`, `cors({ origins, … })`.
Function middleware `(ctx, next) => Response`, or a class with `handle(ctx, next)` built by the container.

## Kernel

`HttpKernel.handle(request)` (no port: used by tests), `listen({ port?, hostname? })`, `stop(timeoutMs)` (waits for
in-flight requests, then closes the rest), `health('live' | 'ready')` (runs checks tagged `HEALTH_CHECKS`, e.g.
the database's). One log line per request: method, path, status, ms, route, requestId.

## `HttpProvider`

Config `http`: `port`, `host`, `shutdownTimeout`, `bodyLimit`, `trustedProxies`, `cors` (api group),
`groups.{web,api}`, `middleware`, `problemBase`, `health`.

## Sessions, CSRF, forms (web group)

`routes/web.ts` routes get `session()` and `csrf()`.

| | |
|---|---|
| `session(options?)` | Loads the session from its cookie (`config('session')`: `cookie` (`cslug_session`), `lifetime` (`14d`), `sameSite`, `domain`), saves what changed, sends an HttpOnly cookie (Secure in production). Errors are rendered inside it so flashes are saved |
| `ctx.session` | `get`, `put`, `has`, `forget`, `pull`, `flash`, `reflash`, `flashed()`, `errors()`, `old(key?)`, `token()`, `verifyToken()`, `regenerate()` (on login), `invalidate()` (on logout). Without the middleware, using it throws an explanation; `ctx.session.available` is false then |
| `csrf({ except? })` | 419 for POST/PUT/PATCH/DELETE without the session token (`_token` form field or `X-CSRF-Token` header) |
| form errors | A `ValidationError` on a non-JSON, non-GET request with a session → **303 back** (Referer) with `_errors` (translated) and `_old` (input without passwords, tokens, files) flashed |
| method spoofing | A form POST with `_method=PUT/PATCH/DELETE` is routed as that method |
| `redirect().with(k, v)` / `.intended(fallback)` | Flash / go to `session('url.intended')` |
| `request.cookie(name)` | |

## Throttle and locale

| | |
|---|---|
| `throttle('5/min', key?)` | Through the `RateLimiter` (memory, or Redis). Key: route + (user, else IP), or your function. `X-RateLimit-Limit/Remaining`; over → 429 with `Retry-After` |
| `locale()` | `:locale` param → `locale` cookie → `Accept-Language` (weighted, region stripped) → default; only `config('i18n.locales')`. Sets `ctx.locale` and the ambient locale (`t()`) |

## Static files

GET/HEAD requests that match no route are served from `public/` (`config('http.public')`: a folder name, or
`false`). Dotfiles and paths escaping the folder are refused. Hashed build files (`name-1a2b3c4d.js`) get
`Cache-Control: public, max-age=31536000, immutable`; others revalidate with `Last-Modified` / 304.

## Commands

| | |
|---|---|
| `cslug serve [--port] [--host] [--reuse-port] [--with-worker] [--with-scheduler]` | The HTTP server; SIGTERM drains in-flight requests. `--with-worker` / `--with-scheduler` also run `queue:work` / `schedule:work` in this process (one-process deployment, guide 21); they are found by signature, so http does not import the queue, and missing commands are an error |
| `cslug routes [filter] [--json]` | The routes, with names and middleware |
