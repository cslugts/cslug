import { AsyncLocalStorage } from 'node:async_hooks'
import type { Application } from './application'
import { type Container, constructing } from './container'
import { CslugError } from './errors'
import type { Token } from './token'

/**
 * What cslug keeps for one unit of work (a request, a job, a command). Set by the kernels; read anywhere.
 * See docs/architecture.md § Ambient context. More fields (requestId, locale, user, tx) are added by the packages
 * that own them.
 */
export interface Context {
  app: Application
  scope: Container
  [key: string]: unknown
}

const storage = new AsyncLocalStorage<Context>()
let defaultApp: Application | undefined

/** Run `fn` inside a context (kernels do this per unit of work; tests per test). */
export function runInContext<T>(context: Context, fn: () => T): T {
  return storage.run(context, fn)
}

/** The current context, or undefined outside any unit of work. */
export function currentContext(): Context | undefined {
  return storage.getStore()
}

/** Called by `Application.start()`: the app used by static shortcuts outside any context (scripts, REPL). */
export function setDefaultApp(app: Application | undefined): void {
  defaultApp = app
}

/** The current application: the context's, else the last started one. */
export function currentApp(): Application {
  const app = storage.getStore()?.app ?? defaultApp
  if (!app)
    throw new CslugError(
      'app.not_started',
      'No application is running. Call app.start() first (or use testApp() in tests).',
    )
  return app
}

/**
 * Resolve from the container that is building the current object, else the current request/job scope, else
 * the current application. For base classes and route closures:
 *
 * ```ts
 * export abstract class AdminController {
 *   protected log = resolve(Logger).child({ area: 'admin' })
 * }
 * ```
 */
export function resolve<T>(token: Token<T>): T {
  const container = constructing.at(-1) ?? storage.getStore()?.scope ?? currentApp()
  return container.resolve(token)
}
