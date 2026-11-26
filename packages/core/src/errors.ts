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

/**
 * An error the application expects and can show: it has an HTTP status and a stable `code`, which is also the
 * translation key for the message shown to users. Apps extend it for their own domain errors.
 */
export class AppError extends CslugError {
  readonly status: number
  readonly params?: Record<string, unknown>

  constructor(
    code: string,
    message?: string,
    options: { status?: number; params?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(code, message ?? code, { cause: options.cause })
    this.status = options.status ?? 500
    this.params = options.params
  }
}

/** Base for errors that map to a specific HTTP status. */
export class HttpError extends AppError {}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** 404. `new NotFoundError('booking', id)` → code `booking.not_found`. */
export class NotFoundError extends HttpError {
  constructor(resource = 'resource', id?: string | number) {
    super(`${resource}.not_found`, `${capitalize(resource)}${id === undefined ? '' : ` ${id}`} not found`, {
      status: 404,
      params: { resource, ...(id === undefined ? {} : { id }) },
    })
  }
}

/** 403. The user is known but not allowed. */
export class ForbiddenError extends HttpError {
  constructor(code = 'auth.forbidden', message?: string) {
    super(code, message ?? 'This action is not allowed.', { status: 403 })
  }
}

/** 401. Not logged in (or the token is invalid). */
export class UnauthorizedError extends HttpError {
  constructor(code = 'auth.unauthenticated', message?: string) {
    super(code, message ?? 'Authentication is required.', { status: 401 })
  }
}

/** 409. The request conflicts with the current state: `new ConflictError('booking.invalid_transition', { from, to })`. */
export class ConflictError extends HttpError {
  constructor(code: string, params?: Record<string, unknown>, message?: string) {
    super(code, message, { status: 409, params })
  }
}

/** 400. The request is malformed (not a validation problem: those are ValidationError / 422). */
export class BadRequestError extends HttpError {
  constructor(code = 'http.bad_request', message?: string) {
    super(code, message ?? 'The request is malformed.', { status: 400 })
  }
}

/** 429. `retryAfter` in seconds becomes the Retry-After header. */
export class TooManyRequestsError extends HttpError {
  constructor(readonly retryAfter?: number) {
    super('http.too_many_requests', 'Too many requests. Try again later.', {
      status: 429,
      params: retryAfter ? { retryAfter } : undefined,
    })
  }
}
