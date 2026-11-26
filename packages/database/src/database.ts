import { type Context, currentContext, Logger, runInContext, type TransactionHooks } from '@cslug/core'
import { SQL } from 'bun'
import { isRetryable, RowCountError, toQueryError } from './errors'
import { SqlFragment } from './sql'
import type { Row, Table } from './table'

export type DatabaseConfig = {
  url: string
  pool?: { max?: number; idleTimeout?: string | number; connectTimeout?: string | number }
  /** Queries slower than this are logged as warnings (text only, never parameters). Default 200 ms. */
  slowQueryMs?: number
}

type Driver = {
  unsafe(text: string, params?: unknown[]): Promise<Record<string, unknown>[] & { count?: number }>
}
type BunTransaction = Driver & { savepoint<T>(fn: (sp: BunTransaction) => Promise<T>): Promise<T> }

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
const camelKeys = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v]))
const seconds = (v: string | number | undefined, fallback: number) =>
  v === undefined ? fallback : typeof v === 'number' ? v : Number.parseFloat(v) * (v.endsWith('ms') ? 0.001 : 1)

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
  async many<T extends Table>(query: SqlFragment<unknown>, table: T): Promise<Row<T>[]>
  async many(query: SqlFragment<unknown>, table?: Table): Promise<unknown[]> {
    const rows = await this.run(query)
    return table ? rows.map((r) => table.fromDb(r)) : rows.map(camelKeys)
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
    readonly handle: BunTransaction,
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
  protected readonly slowQueryMs: number

  constructor(
    readonly config: DatabaseConfig,
    protected readonly log: Logger = Logger.null(),
  ) {
    super()
    this.slowQueryMs = config.slowQueryMs ?? 200
    this.pool = new SQL(config.url, {
      bigint: true, // int8 as bigint (money!), not strings
      max: config.pool?.max ?? 10,
      idleTimeout: seconds(config.pool?.idleTimeout, 30),
      connectionTimeout: seconds(config.pool?.connectTimeout, 5),
    })
  }

  /** The transaction open in the current context, if any. */
  get current(): Transaction | undefined {
    const tx = currentContext()?.tx
    return tx instanceof Transaction ? tx : undefined
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
    // Bun.sql runs transaction callbacks outside the caller's async context, so it is re-entered here
    const enter = (tx: Transaction) => runInContext({ ...(ctx ?? {}), tx } as Context, () => fn(tx))

    if (parent) {
      let child: Transaction | undefined
      const result = await parent.handle.savepoint(async (sp) => {
        child = new Transaction(sp, this.log, this.slowQueryMs, parent.depth + 1)
        return enter(child)
      })
      if (child) parent.hooks.push(...child.hooks) // released savepoint: its hooks belong to the parent now
      return result
    }

    for (let attempt = 0; ; attempt++) {
      let tx: Transaction | undefined
      try {
        const begin = options.isolation ? `isolation level ${options.isolation}` : ''
        const run = async (handle: unknown) => {
          tx = new Transaction(handle as BunTransaction, this.log, this.slowQueryMs)
          return enter(tx)
        }
        const result = (begin ? await this.pool.begin(begin, run) : await this.pool.begin(run)) as T
        await this.runHooks(tx)
        return result
      } catch (error) {
        if (attempt < (options.retry ?? 0) && isRetryable(error)) continue
        throw error
      }
    }
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
    const conn = await this.pool.reserve()
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

  async close(): Promise<void> {
    await this.pool.close()
  }
}
