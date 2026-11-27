import { type Context, currentContext, Logger, runInContext, type TransactionHooks } from '@cslug/core'
import { SQL } from 'bun'
import { isRetryable, RowCountError, toQueryError } from './errors'
import { SqlFragment } from './sql'
import type { Row, Table } from './table'

export type DatabaseConfig = {
  url: string
  /**
   * `max` connections for queries, and as many again for transactions (a separate pool that is only used
   * through `reserve()`, see `transactionPool`).
   */
  pool?: { max?: number; idleTimeout?: string | number; connectTimeout?: string | number }
  /** Queries slower than this are logged as warnings (text only, never parameters). Default 200 ms. */
  slowQueryMs?: number
}

type Driver = {
  unsafe(text: string, params?: unknown[]): Promise<Record<string, unknown>[] & { count?: number }>
}
/** A connection reserved from the pool for one transaction. */
type Reserved = Driver & { release(): void }

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
const camelKeys = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v]))
const seconds = (v: string | number | undefined, fallback: number) =>
  v === undefined ? fallback : typeof v === 'number' ? v : Number.parseFloat(v) * (v.endsWith('ms') ? 0.001 : 1)

/** A value after a JSON round trip: bigint and Date become strings. What `idempotent()` returns. */
export type Json<T> = T extends bigint | Date
  ? string
  : T extends (infer U)[]
    ? Json<U>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T

export type TransactionOptions = {
  isolation?: 'read committed' | 'repeatable read' | 'serializable'
  /** Retry the whole transaction this many times on serialization failures and deadlocks. */
  retry?: number
}

/** Query methods shared by the database and a transaction handle. */
export abstract class Queryable {
  protected abstract driver(): Driver
  protected abstract readonly log: Logger
  protected abstract readonly slowQueryMs: number

  /** Run a query; rows keyed in camelCase, or mapped and typed by `table`. */
  async many<T>(query: SqlFragment<T>): Promise<T[]>
  async many<T extends Table>(query: SqlFragment<unknown>, table: T, extras?: readonly string[]): Promise<Row<T>[]>
  async many(query: SqlFragment<unknown>, table?: Table, extras: readonly string[] = []): Promise<unknown[]> {
    const rows = await this.run(query)
    return table ? rows.map((r) => table.fromDb(r, extras)) : rows.map(camelKeys)
  }

  /** Exactly one row, else `RowCountError`. */
  async one<T>(query: SqlFragment<T>): Promise<T>
  async one<T extends Table>(query: SqlFragment<unknown>, table: T): Promise<Row<T>>
  async one(query: SqlFragment<unknown>, table?: Table): Promise<unknown> {
    const rows = table ? await this.many(query, table) : await this.many(query)
    if (rows.length !== 1) throw new RowCountError('db.row_count', `Expected exactly one row, got ${rows.length}`)
    return rows[0]
  }

  /** The first row, or null. */
  async maybeOne<T>(query: SqlFragment<T>): Promise<T | null>
  async maybeOne<T extends Table>(query: SqlFragment<unknown>, table: T): Promise<Row<T> | null>
  async maybeOne(query: SqlFragment<unknown>, table?: Table): Promise<unknown> {
    const rows = table ? await this.many(query, table) : await this.many(query)
    return rows[0] ?? null
  }

  /** The first column of the first row (or undefined). */
  async value<T = unknown>(query: SqlFragment<unknown>): Promise<T | undefined> {
    const [row] = await this.run(query)
    return row ? (Object.values(row)[0] as T) : undefined
  }

  /** A statement without rows; returns the affected row count. */
  async exec(query: SqlFragment<unknown>): Promise<number> {
    const result = await this.run(query)
    return Number(result.count ?? result.length)
  }

  protected async run(query: SqlFragment<unknown>): Promise<Record<string, unknown>[] & { count?: number }> {
    const { text, params } = query.compile()
    const started = performance.now()
    try {
      return await this.driver().unsafe(text, params)
    } catch (error) {
      throw toQueryError(error, text)
    } finally {
      const ms = performance.now() - started
      if (ms > this.slowQueryMs) this.log.warn('slow query', { ms: Math.round(ms), sql: text })
    }
  }
}

/** An open transaction (or savepoint). Its `afterCommit` hooks run only if the outermost transaction commits. */
export class Transaction extends Queryable implements TransactionHooks {
  readonly hooks: (() => unknown)[] = []

  constructor(
    readonly handle: Driver,
    protected readonly log: Logger,
    protected readonly slowQueryMs: number,
    readonly depth = 0,
  ) {
    super()
  }

  protected driver(): Driver {
    return this.handle
  }

  afterCommit(fn: () => unknown): void {
    this.hooks.push(fn)
  }
}

/**
 * The database: a `Bun.sql` connection pool. Queries run on the **current transaction** when one is open
 * (ambient, through the async context), else on the pool.
 */
export class Database extends Queryable {
  readonly pool: SQL
  /**
   * Transactions get connections from their own pool, only ever through `reserve()`. Bun.sql (1.3.14) can,
   * while a pool opens its connections under concurrency, run a plain pooled query on a connection that is
   * reserved for a transaction: the query lands inside someone else's transaction and both stall ("idle in
   * transaction"). With no plain queries in this pool, that cannot happen. See docs/open-questions.md.
   */
  readonly transactionPool: SQL
  protected readonly slowQueryMs: number

  constructor(
    readonly config: DatabaseConfig,
    protected readonly log: Logger = Logger.null(),
  ) {
    super()
    this.slowQueryMs = config.slowQueryMs ?? 200
    const options = {
      bigint: true, // int8 as bigint (money!), not strings
      max: config.pool?.max ?? 10,
      idleTimeout: seconds(config.pool?.idleTimeout, 30),
      connectionTimeout: seconds(config.pool?.connectTimeout, 5),
    }
    this.pool = new SQL(config.url, options)
    this.transactionPool = new SQL(config.url, options)
  }

  /** Set by `pin()` (the test kit): queries without an ambient transaction use it. */
  private pinned?: Transaction

  /** The transaction open in the current context, else the pinned one, if any. */
  get current(): Transaction | undefined {
    const tx = currentContext()?.tx
    return tx instanceof Transaction ? tx : this.pinned
  }

  /**
   * Open a transaction that stays open until `release()`, and route every query that has no ambient transaction
   * to it. `release()` rolls it back. The test kit pins one per test, so tests never leave data behind.
   * Nested `transaction()` calls become savepoints, and their `afterCommit` hooks run when the savepoint is
   * released (as if committed), so after-commit behaviour stays testable.
   */
  async pin(): Promise<{ release(): Promise<void> }> {
    if (this.pinned) throw new Error('A transaction is already pinned')
    const conn = (await this.transactionPool.reserve()) as unknown as Reserved
    await conn.unsafe('begin')
    this.pinned = new Transaction(conn, this.log, this.slowQueryMs)
    return {
      release: async () => {
        this.pinned = undefined
        try {
          await conn.unsafe('rollback')
        } finally {
          conn.release()
        }
      },
    }
  }

  protected driver(): Driver {
    return (this.current?.handle ?? this.pool) as unknown as Driver
  }

  /** Fails if the database is unreachable (used by the provider's boot and `/health/ready`). */
  async ping(): Promise<void> {
    await this.run(new SqlFragment(['select 1'], []))
  }

  /**
   * Run `fn` in a transaction. Repositories and `db` calls inside it use the transaction automatically; a throw
   * rolls back. Nested calls are savepoints. `afterCommit` hooks (jobs, queued listeners, mail) run after the
   * outermost commit, and never on rollback.
   */
  async transaction<T>(fn: (tx: Transaction) => Promise<T> | T, options: TransactionOptions = {}): Promise<T> {
    const parent = this.current
    const ctx = currentContext()
    const enter = (tx: Transaction) => runInContext({ ...(ctx ?? {}), tx } as Context, () => fn(tx))
    if (parent) return this.savepoint(parent, enter)

    for (let attempt = 0; ; attempt++) {
      // a connection of the transaction pool, with explicit BEGIN/COMMIT (see `transactionPool`)
      const conn = (await this.transactionPool.reserve()) as unknown as Reserved
      let tx: Transaction | undefined
      let committed = false
      try {
        await conn.unsafe(options.isolation ? `begin isolation level ${options.isolation}` : 'begin')
        tx = new Transaction(conn, this.log, this.slowQueryMs)
        const result = await enter(tx)
        await conn.unsafe('commit')
        committed = true
        conn.release()
        await this.runHooks(tx)
        return result
      } catch (error) {
        if (!committed) {
          await conn.unsafe('rollback').catch(() => {})
          conn.release()
        }
        if (!committed && attempt < (options.retry ?? 0) && isRetryable(error)) continue
        throw error
      }
    }
  }

  private savepoints = 0

  /** A nested transaction: a savepoint on the parent's connection. */
  private async savepoint<T>(parent: Transaction, enter: (tx: Transaction) => Promise<T> | T): Promise<T> {
    const name = `cslug_sp_${++this.savepoints}`
    await parent.handle.unsafe(`savepoint ${name}`)
    const child = new Transaction(parent.handle, this.log, this.slowQueryMs, parent.depth + 1)
    let result: T
    try {
      result = await enter(child)
    } catch (error) {
      await parent.handle.unsafe(`rollback to savepoint ${name}`).catch(() => {})
      await parent.handle.unsafe(`release savepoint ${name}`).catch(() => {})
      throw error
    }
    await parent.handle.unsafe(`release savepoint ${name}`)
    // a released savepoint's hooks belong to the parent, except under a pin, where it counts as committed
    if (parent === this.pinned) await this.runHooks(child)
    else parent.hooks.push(...child.hooks)
    return result
  }

  private async runHooks(tx: Transaction | undefined): Promise<void> {
    if (!tx) return
    const ctx = currentContext()
    for (const hook of tx.hooks) {
      try {
        // outside the (now finished) transaction
        await runInContext({ ...(ctx ?? {}), tx: undefined } as Context, async () => hook())
      } catch (error) {
        this.log.error('afterCommit hook failed (the transaction is committed)', { error })
      }
    }
  }

  /** Run `fn` outside the current transaction (e.g. an audit log that must survive a rollback). */
  withoutTransaction<T>(fn: () => T): T {
    const ctx = currentContext()
    return ctx ? runInContext({ ...ctx, tx: undefined }, fn) : fn()
  }

  /**
   * A cluster-wide mutex in Postgres: only one holder of `key` at a time, across all app instances. Inside a
   * transaction the lock lasts until it ends; outside, a dedicated connection holds it while `fn` runs.
   */
  async advisoryLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const tx = this.current
    if (tx) {
      await tx.exec(new SqlFragment(['select pg_advisory_xact_lock(hashtextextended(', ', 0))'], [key]))
      return fn()
    }
    const conn = await this.transactionPool.reserve() // reserve-only pool (see transactionPool)
    try {
      await conn.unsafe('select pg_advisory_lock(hashtextextended($1, 0))', [key])
      try {
        return await fn()
      } finally {
        await conn.unsafe('select pg_advisory_unlock(hashtextextended($1, 0))', [key])
      }
    } finally {
      conn.release()
    }
  }

  /**
   * Run `fn` once per key: the first result is stored as JSON and returned to every call with the same key,
   * the first one included, so the shape is always the same (`Json<T>`: bigint and Date as strings).
   * Concurrent calls wait for each other (advisory lock). Inside a transaction, the record commits or rolls back
   * with your changes. Needs the framework migration `cslug_idempotency` (run by `cslug migrate`).
   *
   * ```ts
   * const transfer = await db.idempotent(`release:${bookingId}:1`, () => gateway.release(…))
   * ```
   */
  async idempotent<T>(key: string, fn: () => Promise<T> | T, options: { scope?: string } = {}): Promise<Json<T>> {
    const scope = options.scope ?? 'default'
    return this.advisoryLock(`idempotent:${scope}:${key}`, async () => {
      const existing = await this.maybeOne(
        new SqlFragment<{ result: Json<T> }>(
          ['select result from cslug_idempotency where scope = ', ' and key = ', ''],
          [scope, key],
        ),
      )
      if (existing) return existing.result
      const result = await fn()
      const json = JSON.stringify(result === undefined ? null : result, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      )
      await this.exec(
        new SqlFragment(
          ['insert into cslug_idempotency (scope, key, result) values (', ', ', ', (', '::text)::jsonb)'],
          [scope, key, json],
        ),
      )
      return JSON.parse(json) as Json<T>
    })
  }

  async close(): Promise<void> {
    await Promise.all([this.pool.close(), this.transactionPool.close()])
  }
}
