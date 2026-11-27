# @cslug/core: API

## `@inject`

| | |
|---|---|
| `@inject(A, B, …)` | The class is buildable by the container; the list names its constructor dependencies in order, and `tsc` checks the list against the constructor. Lifetime: **scoped** |
| `@inject.singleton(…)` | One instance per application |
| `@inject.transient(…)` | A new instance on every resolve |
| `@inject()` | No dependencies |

Registrations are inherited: a subclass without its own `@inject` uses its parent's. Standard (TC39) decorators;
no `experimentalDecorators`, no metadata.

## Tokens

| | |
|---|---|
| a class / abstract class | `PaymentGateway`: abstract classes are the "interfaces" |
| `token<T>(name)` | `InjectionToken<T>` for values: `const COMMISSION = token<number>('payments.commission_percent')` |
| `Token<T>`, `Resolved<K>`, `Class<T>` | Types |

## `Container`

| Method | |
|---|---|
| `singleton(token, impl?)` | `impl` = a class (built with its `@inject` deps) or a factory `(container) => value`; omitted = the token itself |
| `scoped(token, impl?)` | One per scope |
| `bind(token, impl)` | Transient |
| `instance(token, value)` | An existing value |
| `resolve(token)` | A binding, else an `@inject` class, else `BindingNotFoundError` |
| `has(token)` | Bound here or in a parent, or an `@inject` class |
| `when(Consumer).needs(token).give(impl)` | Contextual binding |
| `tag(tokens, name)` / `tagged(name)` | Collections |
| `swap(token, value)` / `restoreSwaps()` | Test overrides (on the root) |
| `createScope()` | Child container for one request, job or command |
| `dispose()` | Disposes the scope's own instances (`Symbol.asyncDispose` / `Symbol.dispose`), newest first |
| `build(Class)` | Construct a class with its `@inject` deps, without caching |

Rules: singletons are cached on the container that owns the binding (normally the root) and get their
dependencies from it, never from a request scope. A singleton that depends on a scoped class throws
`ScopeViolationError`. A cycle throws `CircularDependencyError`, also through factories.

## `ServiceProvider`

```ts
export class XProvider extends ServiceProvider /* implements ProviderHooks */ {
  static dependsOn = [OtherProvider]   // optional
  register() {}                         // bind only; resolving here throws ProviderError
  async boot() {}                       // after every register(), in dependency order
  async shutdown() {}                   // reverse boot order
}
```

The hooks and `dependsOn` are not declared on the base class, so apps using `noImplicitOverride` don't need
`override`. `ProviderHooks` gives the hook signatures for `implements`.

In `register()`, `this.commands([...])` contributes `cslug` commands (tag `COMMANDS`) and
`this.describe('routes', () => data)` a `cslug describe` section (tag `DESCRIBE`, `DescribeSection`).

## `Application` (extends `Container`)

| | |
|---|---|
| `new Application({ root?, configs? })` | `rootDir`, `configs`; the app is bound to itself (`@inject(Application)`) |
| `useProviders(list)` | Before `start()`; `providers` returns the list |
| `start({ signals? })` | `register()` all, then `boot()` in order. On a failed boot: shuts down the booted ones in reverse, then throws `ProviderError` with the original error as `cause`. `signals: true` installs SIGTERM/SIGINT → `shutdown()` → exit |
| `shutdown()` | Reverse order; idempotent; collects errors into an `AggregateError` |
| `isRunning` | |
| `sortProviders(list)` | The boot order (Kahn; listed order kept where dependencies allow). Throws on duplicates, providers missing from the list, and cycles (with the path) |

## Ambient context

| | |
|---|---|
| `runInContext({ app, scope, … }, fn)` | Kernels and the test kit run each unit of work in a context |
| `currentContext()` | The context, or undefined |
| `currentApp()` | The context's app, else the last started app |
| `resolve(token)` | From the container building the current object (field initialisers), else the context scope, else the current app |

## Errors

All extend `CslugError` (`code`, `message`): `BindingNotFoundError` (`container.binding_not_found`),
`CircularDependencyError`, `ScopeViolationError`, `ProviderError` (`app.provider`).

## Config and env

| | |
|---|---|
| `defineEnv(shape, source = process.env)` | Validates immediately with `v` schemas; typed, frozen result. Empty values count as missing. Throws `EnvError` listing **every** problem (`name  message`), with hints (`APP_KEY` → `cslug key:generate`). Secret values are never printed |
| `secretKeys(shape)` | Names of `v.secret()` variables, for redaction |
| `defineConfig(object)` | A config file's default export; returns the object, typed |
| `config(path)` | Typed read from the current app: `config('payments.commissionPercent')`. Paths and value types come from the app's `Config` (see below). Arrays are leaves |
| `app.config(path)` | Untyped read (`unknown` by default), used by packages |
| `app.setConfig(path, value)` | Override before `start()` (the test kit); config is deep-frozen at start |
| `Config`, `Typed<T>`, `ConfigPath<T>`, `ConfigValue<T, P>` | `declare module '@cslug/core' { interface Config extends Typed<typeof configs> {} }` |

`v`, `ValidationError`, `sniffType` and `parseSize` are re-exported from `@cslug/validation`.

## Errors

| Class | Status | Code |
|---|---|---|
| `CslugError(code, message)` | — | base of everything cslug throws |
| `AppError(code, message?, { status?, params?, cause? })` | 500 by default | base for errors shown to users; `code` is the translation key |
| `HttpError` | — | base for the classes below |
| `NotFoundError(resource?, id?)` | 404 | `<resource>.not_found` |
| `ForbiddenError(code?, message?)` | 403 | `auth.forbidden` |
| `UnauthorizedError(code?, message?)` | 401 | `auth.unauthenticated` |
| `ConflictError(code, params?, message?)` | 409 | yours, e.g. `booking.invalid_transition` |
| `BadRequestError(code?, message?)` | 400 | `http.bad_request` |
| `TooManyRequestsError(retryAfter?)` | 429 | `http.too_many_requests` |
| `ValidationError` | 422 | `validation.failed` (from `@cslug/validation`) |

## Clock

Bound as a singleton; its time zone is `config('app.timezone')` (default UTC). At `start()` the app points
`v.date().future()/past()` at it.

| | |
|---|---|
| `now()` | `Date` |
| `today(offsetDays = 0, tz?)` | `'YYYY-MM-DD'` in the time zone |
| `add(duration)` / `subtract(duration)` | `Date` relative to now |
| `atLocal(date, 'HH:mm', tz?)` | The instant of a local wall-clock time; DST-safe |
| `FakeClock(tz?, start?)` | For tests: frozen time; `travelTo(instant)`, `advance(duration)`, `freeze()` |

`parseDuration('1h30m')` → ms. Units: `ms s m h d w`. Invalid input throws (never a silent 0).

## Money

Immutable; integer minor units (`bigint`) + ISO 4217 currency; no floating point anywhere.

| | |
|---|---|
| `Money.of(amount, currency)` | Amount: bigint, safe integer, or digit string. Currency checked against Intl's list |
| `Money.from({ amount, currency })` / `Money.zero(c)` / `Money.sum(list, c?)` | |
| `add`, `subtract` | Same currency only (`money.currency_mismatch`) |
| `multiply(factor)` / `percent(p)` | Decimal factors (`'1.005'`, `2.5`); rounded **half away from zero** to the minor unit |
| `allocate([30, 40, 30])` | Splits without losing a cent; the remainder goes to the first shares |
| `negate`, `isZero`, `isPositive`, `isNegative`, `equals`, `compare` | |
| `toDecimal()` | `'2200.00'` (digits from Intl: EUR 2, JPY 0, KWD 3) |
| `format(locale, options?)` | `2 200,00 €` (fr), `€2,200.00` (en); exact for any size |
| `toJSON()` | `{ amount: '220000', currency: 'EUR' }` |
| `minorDigits(currency)` | |

## Events

| | |
|---|---|
| `class X extends Event<Payload>('dot.case_name') {}` | Define an event. `X['payload']` is the payload type |
| `X.emit(payload)` | On the current app's `EventBus`. Closures, then class listeners, in order. A synchronous listener's error rejects `emit` (so the emitter's transaction can roll back) |
| `X.on(fn)` | Function listener; returns an unsubscribe function |
| `@listener(X \| [X, Y], { queued?, queue?, tries?, backoff? })` | Class listener with `handle(payload, event)`, built by the container (scoped). Combine with `@inject(...)` in any order |
| queued listeners | Run **after the transaction commits** (`afterCommit`), never on rollback. Without `@cslug/queue`: in-process in a fresh scope, errors logged. With it: `EventBus.dispatchQueued` sends them as jobs |
| `afterCommit(fn)` | Run once the current transaction commits; outside a transaction, soon after the current task. `@cslug/database` provides the hook (`TransactionHooks`) |
| `registeredListeners()` | For `cslug events` |

## Logger

Bound as a singleton from `config('log')` (`{ level?, format?, targets?, redact?, bindings? }`; `level` defaults to
`LOG_LEVEL`, else `info`; `format` to `LOG_FORMAT`, else `json`); inject `Logger`. Under `cslug start` / `cslug dev`
the app binds `role` (`CSLUG_ROLE`: `web`, `worker`, `scheduler`) on every line.

| | |
|---|---|
| `debug/info/warn/error(message, fields?)` | One JSON line (`time`, `level`, `msg`, fields); `format: 'pretty'` for terminals |
| `child(fields)` | Adds fields to every entry; children write to their parent's targets |
| `targets` | `{ type: 'stdout' }` (default), `{ type: 'stderr' }`, `{ type: 'file', path, keep? }` (`{date}` in the path: one file per day, older ones beyond `keep` deleted), `{ type: 'custom', write }`; each with its own `level` and `format`. `write` alone is one custom target |
| context fields | `requestId`, `jobId`, `originRequestId` (the request, schedule or command that started a job, kept through jobs that dispatch jobs), `userId`, `traceId`, `spanId` from the ambient context, automatically |
| redaction | Keys containing `password`, `secret`, `token`, `authorization`, `cookie`, `apikey`, `api_key`, `cardnumber`, `cvv` (case-insensitive, any depth), plus `redact` (e.g. `secretKeys(envShape)`) |
| safe serialisation | bigint → string, Date → ISO, `toJSON()` (Money), errors with `code`/`status`/`cause`/`stack`, cycles cut |
| `Logger.null()` | Writes nothing |

## Tracing and metrics (`Tracer`, `Metrics`)

Contracts with no-op implementations bound by default; `@cslug/telemetry` binds ones that record and export. http,
queue, database and ai instrument themselves through them (they never import telemetry). Inject `Tracer` / `Metrics`.

| | |
|---|---|
| `tracer.span(name, { kind?, attributes?, parent? }, fn)` | Runs `fn` in a span: the context gains `span`, `traceId`, `spanId`, `traceparent` (so logs and dispatched jobs follow the trace); errors recorded and rethrown; always ended. `parent` is a W3C `traceparent` (default: the current span) |
| `tracer.current()` | The span the context is in |
| `tracer.enabled` / `metrics.enabled` | False for the no-op versions: skip building attributes |
| `span.updateName()`, `setAttributes()`, `recordError()` | |
| `metrics.increment(name, attributes?, by?)` | Counter |
| `metrics.record(name, value, attributes?)` | Histogram (durations in seconds) |
| `metrics.observe(name, read, attributes?)` | Gauge, read when metrics are collected |
| `BasicTracer` / `BasicMetrics` | In-memory versions (`finished` spans, `collect()`): for tests, and the base of exporters |
| `parseTraceparent(value)` | `{ traceId, spanId, sampled }`, or undefined when malformed |

What the packages record (OpenTelemetry semantic conventions):

| Package | Spans | Metrics |
|---|---|---|
| http | `GET /bookings/:id` (server; continues an incoming `traceparent`; 5xx recorded as errors) | `http.server.request.duration` |
| queue | `publish <job>` (producer, its `traceparent` saved in the envelope), `process <job>` (consumer, per attempt) | `messaging.process.duration` (by outcome), `cslug.queue.waiting`, `cslug.queue.oldest_age` |
| database | `SELECT bookings` (client; the operation and first table, never values) | `db.client.operation.duration` |
| ai | `invoke_agent <Agent>`, `chat <model>` (tokens), `execute_tool <name>` | |

## i18n

`Translator` is bound from `resources/lang/` and `config('i18n')` (`{ locales, default, fallback }`).
Files: `<locale>.json`, and `<locale>/<namespace>.json` merged under the file name.

| | |
|---|---|
| `t(key, params?, locale?)` | In the current locale (the context's `locale`, else the default). Missing key → the key |
| messages | ICU subset: `{name}`, `{count, plural, =0 {…} one {# x} other {# xs}}`, `{gender, select, female {…} other {…}}`, nesting |
| fallback | `chain('it')` → `['it', 'en']` from `fallback`, then the default |
| `withLocale(locale, fn)` | Run with another locale (mail to a recipient, a job for a user) |
| `currentLocale()` | |
| `tr(value)` | Pick a locale from translated content (`{ fr, en, it }`), with the fallback chain |
| `validationTranslator(locale?)` | Pass to `ValidationError.messages(…)`; built-in English when a key is missing |
| `formatMoney(amount \| Money, currency?, locale?)` | |
| `formatDate(value, style?, { tz?, locale? })` | `'YYYY-MM-DD'` shown as is; a `Date` in `tz` (default `config('app.timezone')`). Styles: `short`, `medium`, `long`, `full`, or Intl options |
| `Translator`: `translate`, `has`, `keys`, `add`, `fromDirectory` | |

## Contracts (in-memory drivers by default; `@cslug/redis` replaces them)

| Contract | Methods |
|---|---|
| `Cache` | `get`, `set(key, value, ttl?)`, `has`, `forget`, `increment`/`decrement`, `remember(key, ttl, fn)` (concurrent misses run `fn` once), `flexible(key, [fresh, stale], fn)`, `tags([...])` (+ `flush()`), `flush()` |
| `Lock` | `acquire(key, ttl)` → handle or null; `run(key, { ttl, wait? }, fn)`; released only by its owner; expires; `LockTimeoutError` |
| `RateLimiter` | `hit(key, '5/min')` → `{ allowed, remaining, retryAfter }`; `attempt(key, limit, fn)` → boolean; `enforce(key, limit)` → throws `TooManyRequestsError`; `reset(key)`. `parseRate('3/10min')` |
| `SessionStore` | `read(id)`, `write(id, data, ttl)`, `destroy(id)` |

Memory drivers: `MemoryCache` (values cloned, bigint and Date supported), `MemoryLock`, `MemoryRateLimiter`
(sliding window), `MemorySessionStore`. Each is one per application.

## MCP (server side)

The protocol, over any list of tools, shared by `@cslug/ai` (`@mcp()` tools at `POST /mcp`, `cslug mcp:serve`) and
`@cslug/cli` (`cslug mcp:dev`).

| | |
|---|---|
| `McpTool` | `{ name, description, inputSchema, call(args) }`: `call` validates its arguments; what it throws is an error result |
| `handleMcpMessage(message, tools, serverInfo?)` | One JSON-RPC message → its reply (undefined for a notification): `server/discover`, `initialize` (2025-11-25, 2025-06-18, 2025-03-26), `ping`, `tools/list`, `tools/call` (a plain-object result is also `structuredContent`), `-32022` for an unsupported per-request version, `-32601` for an unknown method |
| `serveMcpStdio(tools, serverInfo, io?)` | One message per line on stdin, replies on stdout, until stdin closes; a line that is not JSON gets `-32700` |
| `MCP_VERSIONS` | `2026-07-28` (stateless, `server/discover`) and the `initialize` versions |
| `McpMessage`, `McpReply`, `McpServerInfo` | The shapes |
