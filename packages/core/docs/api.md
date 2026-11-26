# @cslug/core: API (container and providers)

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

## `Application` (extends `Container`)

| | |
|---|---|
| `new Application({ root?, configs? })` | `rootDir`, `configs`; the app is bound to itself (`@inject(Application)`) |
| `useProviders(list)` | Before `start()` |
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
