import { CslugError, NotFoundError, resolve } from '@cslug/core'
import { Database, type Queryable, type Transaction } from './database'
import { Query, setClause, type Where, whereSql } from './query'
import { sql } from './sql'
import type { NewRow, Row, Table } from './table'
import { writeValue } from './write'

const singular = (name: string) =>
  name.endsWith('ies') ? `${name.slice(0, -3)}y` : name.endsWith('s') ? name.slice(0, -1) : name

/** The repository API for one table (what `Repository(table)` classes inherit). */
export interface RepositoryApi<T extends Table> {
  readonly table: T
  readonly db: Database
  where(where: Where<T>): Query<T>
  query(): Query<T>
  withTrashed(): Query<T>
  onlyTrashed(): Query<T>
  find(id: unknown): Promise<Row<T> | null>
  findOrFail(id: unknown): Promise<Row<T>>
  findBy(where: Where<T>): Promise<Row<T> | null>
  findByOrFail(where: Where<T>): Promise<Row<T>>
  existsBy(where: Where<T>): Promise<boolean>
  count(where?: Where<T>): Promise<number>
  all(where?: Where<T>): Promise<Row<T>[]>
  create(values: NewRow<T>): Promise<Row<T>>
  createMany(values: NewRow<T>[]): Promise<Row<T>[]>
  update(id: unknown, values: Partial<Row<T>>): Promise<Row<T>>
  upsert(
    values: NewRow<T>,
    options: { conflict: (keyof Row<T> & string)[]; update?: (keyof Row<T> & string)[] },
  ): Promise<Row<T>>
  delete(id: unknown): Promise<void>
  forceDelete(id: unknown): Promise<void>
  restore(id: unknown): Promise<Row<T>>
  lockForUpdate(id: unknown, options?: { skipLocked?: boolean; noWait?: boolean }): Promise<Row<T>>
  paginate(options?: {
    page?: number
    perPage?: number
    where?: Where<T>
    orderBy?: keyof Row<T> & string
    dir?: 'asc' | 'desc'
  }): ReturnType<Query<T>['paginate']>
  using(tx: Transaction): this
}

/**
 * The base of a repository for one table:
 *
 * ```ts
 * @inject()
 * export class BookingRepository extends Repository(bookings) {
 *   upcomingFor(travellerId: string, today: string) {
 *     return this.where({ travellerId, startDate: gte(today) }).orderBy('startDate').all()
 *   }
 * }
 * ```
 *
 * The `Database` is resolved by the base class, so subclasses only `@inject` what they add.
 */
export function Repository<T extends Table>(table: T) {
  abstract class BaseRepository implements RepositoryApi<T> {
    readonly table = table
    /** The database (queries use the ambient transaction automatically). */
    readonly db: Database = resolve(Database)
    /** Set by `using(tx)`: an explicit transaction instead of the ambient one. */
    protected explicit?: Transaction

    /** The resource name used in NotFoundError codes (`booking.not_found`). */
    protected get resource(): string {
      return singular(table.name)
    }

    protected get exec(): Queryable & Pick<Database, 'current'> {
      if (!this.explicit) return this.db
      const tx = this.explicit
      return Object.assign(Object.create(tx) as Transaction, { current: tx })
    }

    query(): Query<T> {
      return new Query(table, () => this.exec)
    }
    where(where: Where<T>): Query<T> {
      return this.query().where(where)
    }
    withTrashed(): Query<T> {
      return this.query().withTrashed()
    }
    onlyTrashed(): Query<T> {
      return this.query().onlyTrashed()
    }

    protected byId(id: unknown): Where<T> {
      return { [table.primaryKey]: id } as Where<T>
    }

    find(id: unknown) {
      return this.query().where(this.byId(id)).first()
    }
    async findOrFail(id: unknown) {
      const row = await this.find(id)
      if (!row) throw new NotFoundError(this.resource, String(id))
      return row
    }
    findBy(where: Where<T>) {
      return this.where(where).first()
    }
    async findByOrFail(where: Where<T>) {
      const row = await this.findBy(where)
      if (!row) throw new NotFoundError(this.resource)
      return row
    }
    existsBy(where: Where<T>) {
      return this.where(where).exists()
    }
    count(where: Where<T> = {}) {
      return this.where(where).count()
    }
    all(where: Where<T> = {}) {
      return this.where(where).all()
    }

    /** Fill generated and default values (ids, short codes, timestamps). */
    protected prepare(values: Record<string, unknown>): Record<string, unknown> {
      const out = { ...values }
      for (const [key, column] of Object.entries(table.columns)) {
        if (out[key] !== undefined) continue
        if (column.def.generate) out[key] = column.def.generate()
        else if (column.def.defaultValue !== undefined) out[key] = column.def.defaultValue
      }
      return out
    }

    async create(values: NewRow<T>) {
      const [row] = await this.createMany([values])
      return row as Row<T>
    }

    async createMany(list: NewRow<T>[]) {
      if (!list.length) return []
      const prepared = list.map((v) => this.prepare(v as Record<string, unknown>))
      const keys = Object.keys(table.columns).filter((k) => prepared.some((p) => p[k] !== undefined))
      const names = sql.join(keys.map((k) => sql.ident(table.sqlNames.get(k) as string)))
      const rows = prepared.map(
        (p) =>
          sql`(${sql.join(
            keys.map((k) => (p[k] === undefined ? sql`default` : writeValue(p[k], table.columns[k] as never))),
          )})`,
      )
      return this.exec.many(sql`insert into ${table} (${names}) values ${sql.join(rows)} returning *`, table)
    }

    async update(id: unknown, values: Partial<Row<T>>) {
      const where = whereSql(table, this.byId(id))
      const row = await this.exec.maybeOne(
        sql`update ${table} set ${setClause(table, values as Record<string, unknown>)} where ${where} returning *`,
        table,
      )
      if (!row) throw new NotFoundError(this.resource, String(id))
      return row
    }

    async upsert(
      values: NewRow<T>,
      options: { conflict: (keyof Row<T> & string)[]; update?: (keyof Row<T> & string)[] },
    ) {
      const p = this.prepare(values as Record<string, unknown>)
      const keys = Object.keys(table.columns).filter((k) => p[k] !== undefined)
      const conflict = sql.join(options.conflict.map((k) => sql.ident(table.sqlNames.get(k) as string)))
      const updatable = (options.update ??
        keys.filter(
          (k) => !options.conflict.includes(k as never) && k !== table.primaryKey && k !== 'createdAt',
        )) as string[]
      const touch = Object.entries(table.columns).find(([, c]) => c.def.touch)?.[0]
      const sets = [...new Set([...updatable, ...(touch ? [touch] : [])])].map((k) => {
        const name = sql.ident(table.sqlNames.get(k) as string)
        return sql`${name} = excluded.${name}`
      })
      const action = sets.length ? sql`do update set ${sql.join(sets)}` : sql`do nothing`
      const row = await this.exec.maybeOne(
        sql`insert into ${table} (${sql.join(keys.map((k) => sql.ident(table.sqlNames.get(k) as string)))})
          values (${sql.join(keys.map((k) => writeValue(p[k], table.columns[k] as never)))})
          on conflict (${conflict}) ${action} returning *`,
        table,
      )
      return (
        row ??
        (this.where(Object.fromEntries(options.conflict.map((k) => [k, p[k]])) as Where<T>).first() as Promise<Row<T>>)
      )
    }

    /** Soft-deletes when the table has `deletedAt`, deletes otherwise. */
    async delete(id: unknown) {
      const n = await this.query().where(this.byId(id)).delete()
      if (!n) throw new NotFoundError(this.resource, String(id))
    }

    async forceDelete(id: unknown) {
      const n = await this.withTrashed().where(this.byId(id)).forceDelete()
      if (!n) throw new NotFoundError(this.resource, String(id))
    }

    async restore(id: unknown) {
      if (!table.softDeletes) throw new CslugError('db.not_soft_deletable', `${table.name} has no deletedAt column`)
      const n = await this.onlyTrashed()
        .where(this.byId(id))
        .update({ deletedAt: null } as Partial<Row<T>>)
      if (!n) throw new NotFoundError(this.resource, String(id))
      return this.findOrFail(id)
    }

    /** The row, locked `FOR UPDATE` until the transaction ends. Throws NotFoundError. */
    async lockForUpdate(id: unknown, options: { skipLocked?: boolean; noWait?: boolean } = {}) {
      const row = await this.query().where(this.byId(id)).lockForUpdate(options).first()
      if (!row) throw new NotFoundError(this.resource, String(id))
      return row
    }

    paginate(
      options: {
        page?: number
        perPage?: number
        where?: Where<T>
        orderBy?: keyof Row<T> & string
        dir?: 'asc' | 'desc'
      } = {},
    ) {
      let q = this.where(options.where ?? {})
      if (options.orderBy) q = q.orderBy(options.orderBy, options.dir)
      return q.paginate(options.page ?? 1, options.perPage ?? 20)
    }

    /** This repository bound to an explicit transaction (instead of the ambient one). */
    using(tx: Transaction): this {
      const copy = Object.create(this) as this & { explicit?: Transaction }
      copy.explicit = tx
      return copy
    }
  }
  return BaseRepository
}
