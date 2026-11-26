import { CslugError } from '@cslug/core'
import type { Database, Queryable } from './database'
import { Op } from './operators'
import { type SqlFragment, sql } from './sql'
import type { Row, Table } from './table'
import { writeValue } from './write'

/** `where` objects: a value (equality), `null` (IS NULL), or an operator. `undefined` keys are ignored. */
export type Where<T extends Table> = {
  [K in keyof Row<T>]?: Row<T>[K] | Op<NonNullable<Row<T>[K]>> | (null extends Row<T>[K] ? null : never) | undefined
}

type Order = { key: string; dir: 'asc' | 'desc'; nulls?: 'first' | 'last' }
type Trashed = 'without' | 'with' | 'only'

export type Page<R> = { data: R[]; meta: { page: number; perPage: number; total: number; lastPage: number } }

/** Render a where object for a table (AND of its conditions). */
export function whereSql<T extends Table>(table: T, where: Where<T>): SqlFragment<unknown> | null {
  const parts: SqlFragment<unknown>[] = []
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue
    const column = (table.c as Record<string, unknown>)[key]
    if (!column) throw new CslugError('db.unknown_column', `${table.name} has no column "${key}"`)
    if (table.columns[key]?.def.encrypted) {
      throw new CslugError(
        'db.encrypted_where',
        `${table.name}.${key} is encrypted and cannot be used in a where condition`,
      )
    }
    if (value === null) parts.push(sql`${column} is null`)
    else if (value instanceof Op) parts.push(value.render(column))
    else parts.push(sql`${column} = ${value}`)
  }
  return parts.length ? sql.join(parts, sql` and `) : null
}

/** A query on one table. Immutable: every method returns a new query. */
export class Query<T extends Table, R = Row<T>> {
  constructor(
    readonly table: T,
    protected readonly source: () => Queryable & Pick<Database, 'current'>,
    protected readonly state: {
      ands: SqlFragment<unknown>[]
      ors: SqlFragment<unknown>[][]
      order: Order[]
      limit?: number
      offset?: number
      columns?: string[]
      lock?: 'update' | 'update skip locked' | 'update nowait'
      trashed: Trashed
    } = { ands: [], ors: [], order: [], trashed: 'without' },
  ) {}

  protected with<R2 = R>(patch: Partial<Query<T, R>['state']>): Query<T, R2> {
    return new Query<T, R2>(this.table, this.source, { ...this.state, ...patch })
  }

  where(where: Where<T>): Query<T, R> {
    const s = whereSql(this.table, where)
    return s ? this.with({ ands: [...this.state.ands, s] }) : this
  }

  /** `(previous conditions) OR (these)`. */
  orWhere(where: Where<T>): Query<T, R> {
    const s = whereSql(this.table, where)
    return s ? this.with({ ors: [...this.state.ors, [s]] }) : this
  }

  /** A raw condition when no operator fits: `.whereSql(sql\`${t.c.title} % ${q}\`)`. */
  whereSql(condition: SqlFragment<unknown>): Query<T, R> {
    return this.with({ ands: [...this.state.ands, condition] })
  }

  orderBy(
    key: keyof Row<T> & string,
    dir: 'asc' | 'desc' = 'asc',
    options: { nulls?: 'first' | 'last' } = {},
  ): Query<T, R> {
    return this.with({ order: [...this.state.order, { key, dir, nulls: options.nulls }] })
  }

  limit(n: number): Query<T, R> {
    return this.with({ limit: n })
  }

  offset(n: number): Query<T, R> {
    return this.with({ offset: n })
  }

  /** Only some columns: the result type narrows to them. */
  select<K extends keyof Row<T> & string>(...keys: K[]): Query<T, Pick<Row<T>, K>> {
    return this.with<Pick<Row<T>, K>>({ columns: keys })
  }

  /** `SELECT … FOR UPDATE` (inside a transaction). */
  lockForUpdate(options: { skipLocked?: boolean; noWait?: boolean } = {}): Query<T, R> {
    return this.with({ lock: options.skipLocked ? 'update skip locked' : options.noWait ? 'update nowait' : 'update' })
  }

  /** Include soft-deleted rows. */
  withTrashed(): Query<T, R> {
    return this.with({ trashed: 'with' })
  }

  /** Only soft-deleted rows. */
  onlyTrashed(): Query<T, R> {
    return this.with({ trashed: 'only' })
  }

  /** The WHERE clause (with the soft-delete scope). */
  protected conditions(): SqlFragment<unknown> | null {
    const ands = [...this.state.ands]
    if (this.table.softDeletes && this.state.trashed !== 'with') {
      const deleted = (this.table.c as Record<string, unknown>).deletedAt
      ands.push(this.state.trashed === 'only' ? sql`${deleted} is not null` : sql`${deleted} is null`)
    }
    const base = ands.length ? sql.join(ands, sql` and `) : null
    if (!this.state.ors.length) return base
    const groups = [...(base ? [base] : []), ...this.state.ors.map((g) => sql.join(g, sql` and `))]
    return sql`(${sql.join(
      groups.map((g) => sql`(${g})`),
      sql` or `,
    )})`
  }

  protected whereClause(): SqlFragment<unknown> {
    const c = this.conditions()
    return c ? sql` where ${c}` : sql.empty
  }

  /** The SELECT statement. */
  toSql(): SqlFragment<unknown> {
    const t = this.table
    const cols = this.state.columns
      ? sql.join(this.state.columns.map((k) => (t.c as Record<string, unknown>)[k]))
      : t.star
    const order = this.state.order.length
      ? sql` order by ${sql.join(
          this.state.order.map(
            (o) =>
              sql`${(t.c as Record<string, unknown>)[o.key]} ${sql.raw(o.dir)}${o.nulls ? sql.raw(` nulls ${o.nulls}`) : sql.empty}`,
          ),
        )}`
      : sql.empty
    const limit = this.state.limit !== undefined ? sql` limit ${this.state.limit}` : sql.empty
    const offset = this.state.offset !== undefined ? sql` offset ${this.state.offset}` : sql.empty
    const lock = this.state.lock ? sql.raw(` for ${this.state.lock}`) : sql.empty
    return sql`select ${cols} from ${t}${this.whereClause()}${order}${limit}${offset}${lock}`
  }

  private db() {
    const db = this.source()
    if (this.state.lock && !db.current) {
      throw new CslugError('db.lock_outside_transaction', 'lockForUpdate() only makes sense inside db.transaction(…)')
    }
    return db
  }

  async all(): Promise<R[]> {
    return (await this.db().many(this.toSql(), this.table)) as R[]
  }

  async first(): Promise<R | null> {
    return ((await this.limit(1).all())[0] ?? null) as R | null
  }

  async count(): Promise<number> {
    return Number(await this.source().value(sql`select count(*)::int from ${this.table}${this.whereClause()}`))
  }

  async exists(): Promise<boolean> {
    return Boolean(await this.source().value(sql`select exists (select 1 from ${this.table}${this.whereClause()})`))
  }

  /** Update matching rows; `updatedAt` is refreshed. Returns the number of rows changed. */
  async update(values: Partial<Row<T>>): Promise<number> {
    const sets = setClause(this.table, values as Record<string, unknown>)
    return this.source().exec(sql`update ${this.table} set ${sets}${this.whereClause()}`)
  }

  /** Delete matching rows (soft delete when the table has `deletedAt`). Returns the number of rows. */
  async delete(): Promise<number> {
    if (this.table.softDeletes) return this.update({ deletedAt: new Date() } as Partial<Row<T>>)
    return this.forceDelete()
  }

  async forceDelete(): Promise<number> {
    return this.source().exec(sql`delete from ${this.table}${this.whereClause()}`)
  }

  async paginate(page = 1, perPage = 20): Promise<Page<R>> {
    const p = Math.max(1, Math.floor(page))
    const total = await this.count()
    const data = await this.limit(perPage)
      .offset((p - 1) * perPage)
      .all()
    return { data, meta: { page: p, perPage, total, lastPage: Math.max(1, Math.ceil(total / perPage)) } }
  }

  /** Keyset pagination on one column (stable and fast on large tables). `next` feeds the following call. */
  async cursor(options: {
    after?: unknown
    limit: number
    orderBy?: keyof Row<T> & string
  }): Promise<{ data: R[]; next: unknown }> {
    const key = options.orderBy ?? (this.table.primaryKey as keyof Row<T> & string)
    const column = (this.table.c as Record<string, unknown>)[key]
    const q = options.after === undefined ? this : this.whereSql(sql`${column} > ${options.after}`)
    const data = await q.orderBy(key).limit(options.limit).all()
    const last = data.at(-1) as Record<string, unknown> | undefined
    return { data, next: data.length === options.limit && last ? last[key] : null }
  }

  /** Stream every matching row, in batches (keyset on the primary key). */
  async *each(options: { batch?: number } = {}): AsyncGenerator<R> {
    let after: unknown
    for (;;) {
      const { data, next } = await this.cursor({ after, limit: options.batch ?? 500 })
      yield* data
      if (next === null) return
      after = next
    }
  }
}

/** `col = $1, col2 = $2`, with `updatedAt` refreshed. */
export function setClause(table: Table, values: Record<string, unknown>): SqlFragment<unknown> {
  const pairs = table.toDb(values)
  const touched = Object.entries(table.columns).find(([k, c]) => c.def.touch && !(k in values))
  if (touched) pairs.push([table.sqlNames.get(touched[0]) as string, new Date(), touched[1]])
  if (!pairs.length) throw new CslugError('db.empty_update', `Nothing to update on ${table.name}`)
  return sql.join(pairs.map(([name, value, column]) => sql`${sql.ident(name)} = ${writeValue(value, column)}`))
}
