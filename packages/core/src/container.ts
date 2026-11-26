import { BindingNotFoundError, CircularDependencyError, ProviderError, ScopeViolationError } from './errors'
import { injectable, type Lifetime } from './inject'
import { type Class, InjectionToken, type Token, tokenName } from './token'

/** A factory receives the container that is resolving, so it can resolve its own dependencies. */
export type Factory<T> = (container: Container) => T

type Binding = {
  lifetime: Lifetime | 'instance'
  factory: Factory<unknown>
  /** For error messages: what the token is bound to. */
  describe: string
}

/** One step of a resolution, for error messages and scope checks. */
type Step = { token: Token; lifetime: Lifetime | 'instance' }

/**
 * Containers currently constructing an instance (innermost last). Lets field initialisers such as
 * `protected log = resolve(Logger)` resolve from the container that is building the object.
 */
export const constructing: Container[] = []

const isClass = (v: unknown): v is Class =>
  typeof v === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(v))

/**
 * The IoC container. `Application` is the root container; `createScope()` makes a child for one request, job or
 * command: it inherits bindings, keeps its own scoped instances, and is disposed at the end.
 */
export class Container {
  protected readonly bindings = new Map<Token, Binding>()
  protected readonly instances = new Map<Token, unknown>()
  protected readonly contextual = new Map<Class, Map<Token, Binding>>()
  protected readonly tags = new Map<string, Token[]>()
  protected readonly swaps = new Map<Token, unknown>()
  /** Set by Application while providers register: resolving then is a bug (other bindings may be missing). */
  protected registering = false
  /** The chain of the resolution in progress on this container (used by `build` and nested `resolve`). */
  protected currentChain: Step[] = []

  constructor(readonly parent?: Container) {}

  /** The application-level container. */
  get root(): Container {
    let c: Container = this
    while (c.parent) c = c.parent
    return c
  }

  // ── binding ──────────────────────────────────────────────────────────────────────────────────────────
  /** One instance per application. `impl` is a class (built with its `@inject` deps) or a factory. */
  singleton<T>(token: Token<T>, impl?: Class<T> | Factory<T>): this {
    return this.add(token, 'singleton', impl)
  }

  /** One instance per scope (request, job, command). */
  scoped<T>(token: Token<T>, impl?: Class<T> | Factory<T>): this {
    return this.add(token, 'scoped', impl)
  }

  /** A new instance on every resolve. */
  bind<T>(token: Token<T>, impl: Class<T> | Factory<T>): this {
    return this.add(token, 'transient', impl)
  }

  /** Register an existing value. */
  instance<T>(token: Token<T>, value: T): this {
    this.bindings.set(token, { lifetime: 'instance', factory: () => value, describe: 'an instance' })
    this.instances.set(token, value)
    return this
  }

  /** Contextual binding: `when(PublicCircuitController).needs(CircuitRepository).give(CachedCircuitRepository)`. */
  when(consumer: Class) {
    return {
      needs: <T>(token: Token<T>) => ({
        give: (impl: Class<T> | Factory<T>) => {
          const map = this.contextual.get(consumer) ?? new Map<Token, Binding>()
          map.set(token, this.toBinding(token, 'transient', impl))
          this.contextual.set(consumer, map)
          return this
        },
      }),
    }
  }

  /** Group tokens under a name; `tagged(name)` resolves them all. */
  tag(tokens: Token[], name: string): this {
    this.tags.set(name, [...(this.tags.get(name) ?? []), ...tokens])
    return this
  }

  /** The tokens under a tag, without resolving them (command classes, for example). */
  taggedTokens(name: string): Token[] {
    const tokens: Token[] = []
    for (let c: Container | undefined = this; c; c = c.parent) tokens.unshift(...(c.tags.get(name) ?? []))
    return tokens
  }

  tagged<T>(name: string): T[] {
    const tokens: Token[] = []
    for (let c: Container | undefined = this; c; c = c.parent) tokens.unshift(...(c.tags.get(name) ?? []))
    return tokens.map((t) => this.resolve(t) as T)
  }

  /** Replace a token for the rest of a test: `app.swap(PaymentGateway, new FakePaymentGateway())`. */
  swap<T>(token: Token<T>, value: T): this {
    this.root.swaps.set(token, value)
    return this
  }

  /** Remove all swaps (the test kit calls this after each test). */
  restoreSwaps(): this {
    this.root.swaps.clear()
    return this
  }

  /** True if the token is bound here or in a parent, or is an `@inject` class. */
  has(token: Token): boolean {
    return !!this.findBinding(token) || (typeof token === 'function' && !!injectable(token))
  }

  protected add<T>(token: Token<T>, lifetime: Lifetime, impl?: Class<T> | Factory<T>): this {
    this.bindings.set(token, this.toBinding(token, lifetime, impl))
    this.instances.delete(token)
    return this
  }

  protected toBinding<T>(token: Token<T>, lifetime: Lifetime, impl?: Class<T> | Factory<T>): Binding {
    const target = impl ?? token
    if (target instanceof InjectionToken) {
      throw new BindingNotFoundError(`Cannot bind ${tokenName(token)} without a value or factory.`)
    }
    if (isClass(target)) {
      return { lifetime, factory: (c) => c.build(target as Class), describe: tokenName(target) }
    }
    return { lifetime, factory: target as Factory<unknown>, describe: 'a factory' }
  }

  protected findBinding(token: Token): { binding: Binding; owner: Container } | undefined {
    for (let c: Container | undefined = this; c; c = c.parent) {
      const binding = c.bindings.get(token)
      if (binding) return { binding, owner: c }
    }
    return undefined
  }

  // ── resolving ────────────────────────────────────────────────────────────────────────────────────────
  /** Get a bound token, or build an `@inject` class. Throws with the chain of who asked for what. */
  resolve<T>(token: Token<T>): T {
    // inside a factory, continue the resolution in progress (so cycles through factories are detected)
    return this.resolveIn(token, this.currentChain) as T
  }

  /** Internal: resolve with the chain of tokens being built (for cycles, scope checks and messages). */
  resolveIn(token: Token, chain: Step[]): unknown {
    if (this.root.registering) {
      throw new ProviderError(
        `Cannot resolve ${tokenName(token)} during register(): other providers may not have registered yet. Move this into boot(), or resolve lazily inside a factory.`,
      )
    }
    const swapped = this.root.swaps
    if (swapped.has(token)) return swapped.get(token)
    if (chain.some((s) => s.token === token)) {
      throw new CircularDependencyError(
        `Circular dependency: ${[...chain.map((s) => tokenName(s.token)), tokenName(token)].join(' → ')}. Extract the shared part into a third class.`,
      )
    }

    // contextual binding for the class that is asking
    const consumer = chain.at(-1)?.token
    const contextual = typeof consumer === 'function' ? this.findContextual(consumer, token) : undefined
    if (contextual) return this.produce(token, contextual, this, chain)

    const found = this.findBinding(token)
    if (found) return this.produce(token, found.binding, found.owner, chain)

    if (typeof token === 'function') {
      const meta = injectable(token)
      if (meta) {
        const binding: Binding = { lifetime: meta.lifetime, factory: (c) => c.build(token), describe: tokenName(token) }
        return this.produce(token, binding, meta.lifetime === 'singleton' ? this.root : this, chain)
      }
    }
    throw new BindingNotFoundError(notFoundMessage(token, chain))
  }

  protected findContextual(consumer: Class, token: Token): Binding | undefined {
    for (let c: Container | undefined = this; c; c = c.parent) {
      const b = c.contextual.get(consumer)?.get(token)
      if (b) return b
    }
    return undefined
  }

  protected produce(token: Token, binding: Binding, owner: Container, chain: Step[]): unknown {
    if (binding.lifetime === 'instance') return owner.instances.get(token)

    // a singleton must not capture something that only lives for one request
    if (binding.lifetime === 'scoped') {
      const singleton = chain.find((s) => s.lifetime === 'singleton')
      if (singleton) {
        throw new ScopeViolationError(
          `${tokenName(singleton.token)} is a singleton but depends on ${tokenName(token)}, which is scoped (one per request/job). Make ${tokenName(token)} a singleton, or resolve it per call with resolve().`,
        )
      }
    }

    // where the instance is cached: singletons on the container that owns the binding (normally the root),
    // scoped instances on the scope doing the resolving
    const cache = binding.lifetime === 'singleton' ? owner : binding.lifetime === 'scoped' ? this : undefined
    if (cache?.instances.has(token)) return cache.instances.get(token)

    const step: Step = { token, lifetime: binding.lifetime }
    // singletons are built by their owner so their dependencies never come from a request scope
    const builder = binding.lifetime === 'singleton' ? owner : this
    const value = builder.withChain([...chain, step], () => binding.factory(builder))
    cache?.instances.set(token, value)
    return value
  }

  protected withChain<T>(chain: Step[], fn: () => T): T {
    const previous = this.currentChain
    this.currentChain = chain
    try {
      return fn()
    } finally {
      this.currentChain = previous
    }
  }

  /** Construct a class with its `@inject` dependencies. Classes without `@inject` must take no arguments. */
  build<T>(cls: Class<T>): T {
    const meta = injectable(cls)
    const chain = this.currentChain
    const deps = (meta?.deps ?? []).map((d) => this.resolveIn(d, chain))
    if (!meta && cls.length > 0) {
      throw new BindingNotFoundError(
        `Cannot build ${tokenName(cls)}: its constructor takes ${cls.length} argument(s) but the class has no @inject(...). Add @inject(${'…'}) listing them.`,
      )
    }
    constructing.push(this)
    try {
      return new (cls as unknown as new (...args: unknown[]) => T)(...deps)
    } finally {
      constructing.pop()
    }
  }

  // ── scopes ───────────────────────────────────────────────────────────────────────────────────────────
  /** A child container for one unit of work. */
  createScope(): Container {
    return new Container(this)
  }

  /** Dispose this scope's own instances (calls `[Symbol.asyncDispose]` / `[Symbol.dispose]` if present). */
  async dispose(): Promise<void> {
    const values = [...this.instances.values()].reverse()
    this.instances.clear()
    for (const v of values) {
      if (v && typeof v === 'object') {
        const d = v as { [Symbol.asyncDispose]?: () => Promise<void>; [Symbol.dispose]?: () => void }
        if (typeof d[Symbol.asyncDispose] === 'function') await d[Symbol.asyncDispose]?.()
        else if (typeof d[Symbol.dispose] === 'function') d[Symbol.dispose]?.()
      }
    }
  }
}

function notFoundMessage(token: Token, chain: Step[]): string {
  const name = tokenName(token)
  const lines = [`Cannot resolve ${name}`]
  for (const step of [...chain].reverse()) lines.push(`  required by ${tokenName(step.token)}`)
  if (token instanceof InjectionToken) {
    lines.push(
      `  Hint: bind a value in a provider: this.app.instance(${token.name.toUpperCase().replace(/\W/g, '_')}, …)`,
    )
  } else if (typeof token === 'function') {
    lines.push(
      `  Hint: if ${name} is a class you wrote, add @inject(...) to it.`,
      `        If it is abstract (an interface), bind an implementation in a provider:`,
      `        this.app.singleton(${name}, Your${name}Implementation)`,
    )
  }
  return lines.join('\n')
}
