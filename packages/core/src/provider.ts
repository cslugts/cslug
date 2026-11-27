import type { Application } from './application'
import { COMMANDS, type CommandClass, DESCRIBE, type DescribeSection } from './command'
import { token } from './token'

/**
 * The one place a subsystem is wired. `register()` binds, `boot()` connects and listens, `shutdown()` closes.
 *
 * ```ts
 * export class PaymentServiceProvider extends ServiceProvider {
 *   static dependsOn = [DatabaseProvider]
 *   register() { this.app.singleton(PaymentGateway, MangopayGateway) }
 * }
 * ```
 *
 * The hooks and `dependsOn` are deliberately not declared on this base class, so that apps compiled with
 * `noImplicitOverride` don't have to write `override`. Add `implements ProviderHooks` for autocompletion.
 */
export abstract class ServiceProvider {
  constructor(protected readonly app: Application) {}

  /** Contribute `cslug` commands (call in `register()`). */
  protected commands(commands: readonly CommandClass[]): void {
    this.app.tag([...commands] as never[], COMMANDS)
  }

  /** Contribute a `cslug describe` section (call in `register()`); `collect` runs when it is asked for. */
  protected describe(name: string, collect: () => unknown): void {
    const section = token<DescribeSection>(`cslug.describe.${name}`)
    this.app.instance(section, { name, collect })
    this.app.tag([section], DESCRIBE)
  }
}

/** The optional lifecycle hooks of a provider. */
export interface ProviderHooks {
  /** Bind things. Runs for every provider before any boot(). Must not resolve. */
  register?(): void
  /** Everything is registered and the dependencies have booted. */
  boot?(): void | Promise<void>
  /** Reverse boot order, on SIGTERM/SIGINT or app.shutdown(). */
  shutdown?(): void | Promise<void>
}

/** A provider class. `static dependsOn` lists providers that must boot first. */
export type ProviderClass = (new (
  app: Application,
) => ServiceProvider) & { readonly dependsOn?: readonly ProviderClass[] }

export const dependenciesOf = (p: ProviderClass): readonly ProviderClass[] => p.dependsOn ?? []
