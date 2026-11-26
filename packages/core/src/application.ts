import { configure as configureValidation } from '@cslug/validation'
import { Clock } from './clock'
import { deepFreeze, getPath, setPath } from './config'
import { Container } from './container'
import { setDefaultApp } from './context'
import {
  Cache,
  Lock,
  MemoryCache,
  MemoryLock,
  MemoryRateLimiter,
  MemorySessionStore,
  RateLimiter,
  SessionStore,
} from './contracts'
import { ProviderError } from './errors'
import { EventBus } from './events'
import { type I18nConfig, Translator } from './i18n'
import { Logger, type LoggerOptions } from './logger'
import { dependenciesOf, type ProviderClass, type ProviderHooks, type ServiceProvider } from './provider'

export type ApplicationOptions = {
  /** The app's root directory (where bootstrap/, config/, routes/ live). */
  root?: string
  /** Config objects, by section (config/index.ts → `configs`). */
  configs?: Record<string, unknown>
}

type State = 'created' | 'starting' | 'running' | 'stopping' | 'stopped'

/**
 * The application: the root container plus provider orchestration. Built in `bootstrap/app.ts`, started by a
 * kernel (`cslug serve`, `queue:work`, …) or by the test kit.
 */
export class Application extends Container {
  /** The app's root directory. */
  readonly rootDir: string
  protected _configs: Record<string, unknown>
  protected providerClasses: ProviderClass[] = []
  protected booted: (ServiceProvider & ProviderHooks)[] = []
  protected state: State = 'created'
  private signalHandler?: () => void

  constructor(options: ApplicationOptions = {}) {
    super()
    this.rootDir = options.root ?? process.cwd()
    this._configs = options.configs ?? {}
    this.instance(Application, this)
    this.singleton(Clock, () => new Clock((this.config('app.timezone') as string | undefined) ?? 'UTC'))
    this.singleton(Logger, () => new Logger((this.config('log') as LoggerOptions | undefined) ?? {}))
    this.singleton(EventBus, (c) => new EventBus(this, c.resolve(Logger)))
    this.singleton(Translator, () =>
      Translator.fromDirectory(`${this.rootDir}/resources/lang`, (this.config('i18n') as I18nConfig | undefined) ?? {}),
    )
    // in-memory drivers; @cslug/redis replaces them
    this.singleton(Cache, () => new MemoryCache())
    this.singleton(Lock, () => new MemoryLock())
    this.singleton(RateLimiter, () => new MemoryRateLimiter())
    this.singleton(SessionStore, () => new MemorySessionStore())
  }

  /** All config sections. Read-only once the app has started. */
  get configs(): Readonly<Record<string, unknown>> {
    return this._configs
  }

  /** Config at a dotted path (`'payments.stages'`), or undefined. App code uses the typed `config()` helper. */
  config<T = unknown>(path: string): T {
    return getPath(this._configs, path) as T
  }

  /**
   * Override a config value before start (the test kit does this: `testApp({ config: { 'payments.driver': 'fake' } })`).
   * After start, config is frozen.
   */
  setConfig(path: string, value: unknown): this {
    if (this.state !== 'created') throw new ProviderError(`Config is read-only after start (tried to set "${path}").`)
    this._configs = setPath(this._configs, path, value)
    return this
  }

  get isRunning(): boolean {
    return this.state === 'running'
  }

  /** The providers to run, from `bootstrap/providers.ts`. Order matters only where `dependsOn` doesn't decide. */
  useProviders(providers: readonly ProviderClass[]): this {
    if (this.state !== 'created') throw new ProviderError('useProviders() must be called before start().')
    this.providerClasses = [...providers]
    return this
  }

  /**
   * Register every provider, then boot them in dependency order. If a boot() throws, providers that already
   * booted are shut down in reverse order and the error is rethrown.
   */
  async start(options: { signals?: boolean } = {}): Promise<this> {
    if (this.state !== 'created') throw new ProviderError(`Cannot start an application that is ${this.state}.`)
    this.state = 'starting'
    deepFreeze(this._configs)
    // dates validated with v.date().future() follow the app clock and time zone
    configureValidation({ today: () => this.resolve(Clock).today() })
    const order = sortProviders(this.providerClasses)
    const instances = order.map((P) => new P(this) as ServiceProvider & ProviderHooks)

    this.registering = true
    try {
      for (const p of instances) p.register?.()
    } finally {
      this.registering = false
    }

    for (const p of instances) {
      try {
        await p.boot?.()
        this.booted.push(p)
      } catch (error) {
        const rollback = await this.shutdownBooted()
        this.state = 'stopped'
        throw new ProviderError(
          `${p.constructor.name}.boot() failed: ${error instanceof Error ? error.message : String(error)}${
            rollback.length ? ` (and ${rollback.length} provider(s) failed to shut down during rollback)` : ''
          }`,
          { cause: error },
        )
      }
    }
    this.state = 'running'
    setDefaultApp(this)
    if (options.signals) this.handleSignals()
    return this
  }

  /** Shut providers down in reverse boot order. Safe to call twice. Errors are collected, then thrown together. */
  async shutdown(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping' || this.state === 'created') return
    this.state = 'stopping'
    if (this.signalHandler) {
      process.off('SIGTERM', this.signalHandler)
      process.off('SIGINT', this.signalHandler)
    }
    const errors = await this.shutdownBooted()
    await this.dispose()
    this.state = 'stopped'
    setDefaultApp(undefined)
    if (errors.length) throw new AggregateError(errors, `${errors.length} provider(s) failed to shut down`)
  }

  protected async shutdownBooted(): Promise<unknown[]> {
    const errors: unknown[] = []
    for (const p of [...this.booted].reverse()) {
      try {
        await p.shutdown?.()
      } catch (e) {
        errors.push(e)
      }
    }
    this.booted = []
    return errors
  }

  /** On SIGTERM/SIGINT: shut down, then exit (0 if clean, 1 otherwise). Kernels enable this. */
  handleSignals(): void {
    if (this.signalHandler) return
    this.signalHandler = () => {
      this.shutdown().then(
        () => process.exit(0),
        (e) => {
          console.error(e)
          process.exit(1)
        },
      )
    }
    process.once('SIGTERM', this.signalHandler)
    process.once('SIGINT', this.signalHandler)
  }
}

/**
 * Topological order by `dependsOn`, keeping the listed order where dependencies don't decide (Kahn's algorithm).
 * Throws on duplicates, dependencies missing from the list, and cycles.
 */
export function sortProviders(providers: readonly ProviderClass[]): ProviderClass[] {
  const seen = new Set<ProviderClass>()
  for (const p of providers) {
    if (seen.has(p)) throw new ProviderError(`${p.name} is listed twice in the providers.`)
    seen.add(p)
  }
  for (const p of providers) {
    for (const d of dependenciesOf(p)) {
      if (!seen.has(d))
        throw new ProviderError(
          `${p.name} depends on ${d.name}, which is not in the provider list (bootstrap/providers.ts).`,
        )
    }
  }
  const order: ProviderClass[] = []
  const done = new Set<ProviderClass>()
  const remaining = [...providers]
  while (remaining.length) {
    const i = remaining.findIndex((p) => dependenciesOf(p).every((d) => done.has(d)))
    if (i === -1) throw new ProviderError(`Circular provider dependencies: ${describeCycle(remaining)}.`)
    const [next] = remaining.splice(i, 1) as [ProviderClass]
    order.push(next)
    done.add(next)
  }
  return order
}

function describeCycle(remaining: ProviderClass[]): string {
  const left = new Set(remaining)
  let current = remaining[0] as ProviderClass
  const path: ProviderClass[] = []
  while (!path.includes(current)) {
    path.push(current)
    current = dependenciesOf(current).find((d) => left.has(d)) ?? current
  }
  return [...path.slice(path.indexOf(current)), current].map((p) => p.name).join(' → ')
}
