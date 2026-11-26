import { resolve } from '@cslug/core'
import { Database } from './database'
import { inList } from './operators'
import { Query } from './query'
import type { Row, Table } from './table'

type Relation<T extends Table, Many extends boolean> = {
  table: T
  /** Key on the rows being loaded (belongsTo) or on the related table (hasMany). */
  key: string
  many: Many
  orderBy?: string
}

/** The row has `key` pointing at the related table's primary key: `belongsTo(operators, 'operatorId')`. */
export const belongsTo = <T extends Table>(table: T, foreignKey: string): Relation<T, false> => ({
  table,
  key: foreignKey,
  many: false,
})

/** The related table has `key` pointing at the row's primary key: `hasMany(milestones, 'bookingId')`. */
export const hasMany = <T extends Table>(
  table: T,
  foreignKey: keyof Row<T> & string,
  options: { orderBy?: keyof Row<T> & string } = {},
): Relation<T, true> => ({
  table,
  key: foreignKey,
  many: true,
  orderBy: options.orderBy,
})

// biome-ignore lint/suspicious/noExplicitAny: any relation
type Relations = Record<string, Relation<any, boolean>>
type Loaded<R extends Relations> = {
  [K in keyof R]: R[K] extends Relation<infer T, true>
    ? Row<T>[]
    : R[K] extends Relation<infer T, false>
      ? Row<T> | null
      : never
}

/**
 * Load related rows for a list, one query per relation (no N+1):
 *
 * ```ts
 * const rows = await preload(list, { operator: belongsTo(operators, 'operatorId'), milestones: hasMany(milestones, 'bookingId') })
 * ```
 */
export async function preload<Rw extends Record<string, unknown>, R extends Relations>(
  rows: Rw[],
  relations: R,
  options: { primaryKey?: string; db?: Database } = {},
): Promise<(Rw & Loaded<R>)[]> {
  const db = options.db ?? resolve(Database)
  const pk = options.primaryKey ?? 'id'
  const out = rows.map((r) => ({ ...r })) as Record<string, unknown>[]
  for (const [name, rel] of Object.entries(relations)) {
    if (rel.many) {
      const ids = [...new Set(rows.map((r) => r[pk]))]
      let q = new Query(rel.table, () => db).where({ [rel.key]: inList(ids) })
      if (rel.orderBy) q = q.orderBy(rel.orderBy as never)
      const related = (await q.all()) as Record<string, unknown>[]
      for (const row of out) row[name] = related.filter((x) => x[rel.key] === row[pk])
    } else {
      const ids = [...new Set(rows.map((r) => r[rel.key]).filter((v) => v !== null && v !== undefined))]
      const related = ids.length
        ? ((await new Query(rel.table, () => db).where({ [rel.table.primaryKey]: inList(ids) }).all()) as Record<
            string,
            unknown
          >[])
        : []
      const byId = new Map(related.map((x) => [x[rel.table.primaryKey], x]))
      for (const row of out) row[name] = byId.get(row[rel.key]) ?? null
    }
  }
  return out as (Rw & Loaded<R>)[]
}
