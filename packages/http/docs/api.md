# @cslug/http: API (M3a)

## Routes

`defineRoutes((r) => { … })`, loaded by `HttpProvider` from `routes/web.ts` (web group) and `routes/api.ts`
(api group); `router.load(fn, group)` for more.

| | |
|---|---|
| `r.get/post/put/patch/delete/options(path, action)` | `action`: `[Controller, 'method']`, a single-action class (`handle`), or a closure |
| `.name(n)`, `.middleware(...m)`, `.where('param', /re/)` | |
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
`redirect().route(name, params) / .to(url) / .away(url) / .back(fallback) / .intended(fallback) / .with(key, value)`
(303 after non-GET; flash needs sessions, M3b).

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
