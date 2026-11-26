import type { AnyColumn, Column } from './columns'
import { IDENT, quote, type SqlIdentifier } from './sql'

export type Columns = Record<string, AnyColumn>

type ValueOf<C> = C extends Column<infer T, infer N, boolean> ? (N extends true ? T | null : T) : never
type Flatten<T> = { [K in keyof T]: T[K] } & {}
type OptionalKeys<C extends Columns> = {
  [K in keyof C]: C[K] extends Column<unknown, boolean, true> ? K : never
}[keyof C]

/** What a SELECT returns: every column, nullable ones as `T | null`. */
export type Row<T extends Table> = Flatten<{ [K in keyof T['columns']]: ValueOf<T['columns'][K]> }>

/** What an INSERT needs: NOT NULL columns without a default are required; the rest optional. */
export type NewRow<T extends Table> = Flatten<
  { [K in Exclude<keyof T['columns'], OptionalKeys<T['columns']>>]: ValueOf<T['columns'][K]> } & {
    [K in OptionalKeys<T['columns']>]?: ValueOf<T['columns'][K]>
  }
>

/** `fooBar` → `foo_bar` */
export const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

/** A column reference that renders as `"table"."column"` in the sql tag. */
export type ColumnRef = SqlIdentifier & { readonly name: string; readonly key: string; readonly table: string }

export type IndexDef = { columns: string[]; unique: boolean; name: string }

type IndexBuilder<C extends Columns> = {
  index(...keys: (keyof C & string)[]): IndexDef
  unique(...keys: (keyof C & string)[]): IndexDef
}

export class Table<C extends Columns = Columns> implements SqlIdentifier {
  readonly [IDENT]: string
  /** Column references for the sql tag: `${bookings.c.startDate}` → `"bookings"."start_date"`. */
  readonly c: { readonly [K in keyof C]: ColumnRef }
  /** `${bookings.star}` → `"bookings".*` */
  readonly star: SqlIdentifier
  /** TS key → SQL column name. */
  readonly sqlNames: ReadonlyMap<string, string>
  readonly indexes: IndexDef[]
  readonly primaryKey: string

  constructor(
    readonly name: string,
    readonly columns: C,
    options: { indexes?: (t: IndexBuilder<C>) => IndexDef[] } = {},
  ) {
    this[IDENT] = quote(name)
    const names = new Map<string, string>()
    const refs: Record<string, ColumnRef> = {}
    for (const key of Object.keys(columns)) {
      const column = snake(key)
      names.set(key, column)
      refs[key] = { [IDENT]: `${quote(name)}.${quote(column)}`, name: column, key, table: name }
    }
    this.sqlNames = names
    this.c = refs as Table<C>['c']
    this.star = { [IDENT]: `${quote(name)}.*` }
    this.primaryKey = Object.entries(columns).find(([, c]) => c.def.primary)?.[0] ?? 'id'
    const builder: IndexBuilder<C> = {
      index: (...keys) => ({
        columns: keys.map(snake),
        unique: false,
        name: `${name}_${keys.map(snake).join('_')}_idx`,
      }),
      unique: (...keys) => ({
        columns: keys.map(snake),
        unique: true,
        name: `${name}_${keys.map(snake).join('_')}_key`,
      }),
    }
    this.indexes = options.indexes?.(builder) ?? []
  }

  /** True when the table has `deletedAt` (soft deletes). */
  get softDeletes(): boolean {
    return 'deletedAt' in this.columns
  }

  /** A database row (snake_case, driver types) → the app row (camelCase, cslug types). */
  fromDb(raw: Record<string, unknown>): Row<this> {
    const out: Record<string, unknown> = {}
    for (const [key, column] of Object.entries(this.columns)) {
      const name = this.sqlNames.get(key) as string
      if (!(name in raw)) continue
      out[key] = convertFromDb(raw[name], column.def.kind)
    }
    return out as Row<this>
  }

  /** App values (camelCase) → `[sqlName, value]` pairs, for known columns only. */
  toDb(values: Record<string, unknown>): [string, unknown, AnyColumn][] {
    const out: [string, unknown, AnyColumn][] = []
    for (const [key, value] of Object.entries(values)) {
      const column = this.columns[key]
      if (!column || value === undefined) continue
      out.push([this.sqlNames.get(key) as string, value, column])
    }
    return out
  }
}

function convertFromDb(value: unknown, kind: string): unknown {
  if (value === null || value === undefined) return null
  switch (kind) {
    case 'date':
      return value instanceof Date ? value.toISOString().slice(0, 10) : String(value)
    case 'bigint':
      return typeof value === 'bigint' ? value : BigInt(value as string)
    case 'integer':
      return typeof value === 'number' ? value : Number(value)
    case 'numeric':
      return String(value)
    case 'char':
      return String(value).trimEnd()
    default:
      return value
  }
}

/** Define a table: `export const bookings = table('bookings', { id: id(), … })`. */
export function table<C extends Columns>(
  name: string,
  columns: C,
  options: { indexes?: (t: IndexBuilder<C>) => IndexDef[] } = {},
): Table<C> {
  return new Table(name, columns, options)
}
