/**
 * Base class of every error cslug throws. `code` is stable and machine-readable (dot.case); the message says
 * what went wrong and, where possible, how to fix it.
 */
export class CslugError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

/** A container token could not be resolved. */
export class BindingNotFoundError extends CslugError {
  constructor(message: string) {
    super('container.binding_not_found', message)
  }
}

/** Two bindings need each other to be built. */
export class CircularDependencyError extends CslugError {
  constructor(message: string) {
    super('container.circular_dependency', message)
  }
}

/** A singleton depends on a scoped service: it would capture the first request's instance. */
export class ScopeViolationError extends CslugError {
  constructor(message: string) {
    super('container.scope_violation', message)
  }
}

/** Provider list problems: duplicates, missing dependencies, cycles, resolving during register(). */
export class ProviderError extends CslugError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('app.provider', message, options)
  }
}
