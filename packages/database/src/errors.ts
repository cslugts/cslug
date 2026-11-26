import { CslugError } from '@cslug/core'

/** A query failed. `sqlState` is the Postgres error code; the original error is the `cause`. */
export class QueryError extends CslugError {
  constructor(
    code: string,
    message: string,
    readonly sqlState?: string,
    readonly constraint?: string,
    options?: { cause?: unknown },
  ) {
    super(code, message, options)
  }
}

/** 23505: a unique constraint was violated (`constraint` names it). */
export class UniqueViolationError extends QueryError {}

/** 40001 / 40P01: retryable; `db.transaction(fn, { retry })` retries these. */
export class SerializationError extends QueryError {}

/** `db.one()` found no row (or more than one). */
export class RowCountError extends CslugError {}

const RETRYABLE = new Set(['40001', '40P01'])
export const isRetryable = (e: unknown) =>
  e instanceof SerializationError || RETRYABLE.has((e as { errno?: string })?.errno ?? '')

/** Wrap a driver error in a typed error. The SQL text is kept for logs; parameters never are. */
export function toQueryError(error: unknown, text: string): Error {
  const e = error as { errno?: string; constraint?: string; message?: string }
  const state = e?.errno
  const message = `${e?.message ?? String(error)} (query: ${text.length > 300 ? `${text.slice(0, 300)}…` : text})`
  if (state === '23505')
    return new UniqueViolationError('db.unique_violation', message, state, e.constraint, { cause: error })
  if (state && RETRYABLE.has(state))
    return new SerializationError('db.serialization_failure', message, state, undefined, { cause: error })
  return new QueryError('db.query_failed', message, state, e?.constraint, { cause: error })
}
